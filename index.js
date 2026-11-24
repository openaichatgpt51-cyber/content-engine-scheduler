const { createClient } = require('@supabase/supabase-js')

// ── Config ────────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const N8N_WEBHOOK_URL     = process.env.N8N_WEBHOOK_URL
const N8N_WEBHOOK_SECRET  = process.env.N8N_WEBHOOK_SECRET
const N8N_WEBHOOK_HEADER  = process.env.N8N_WEBHOOK_HEADER || 'apikey'
const INTERVAL_MS         = 60_000 // run every 60 seconds
// A post that has sat in IN_PROGRESS longer than this never got a result back
// from n8n (n8n answers the webhook immediately, so a 200 here only means
// "started", not "published"). Normal publishing takes seconds to a few minutes.
const STUCK_AFTER_MINUTES = Number(process.env.STUCK_AFTER_MINUTES || 15)
// How long after hand-off we look at what n8n actually did. A due platform that
// is still not marked posted by then was discarded or failed inside n8n.
const VERIFY_AFTER_MINUTES = Number(process.env.VERIFY_AFTER_MINUTES || 3)

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !N8N_WEBHOOK_URL) {
  console.error('Missing required environment variables')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// ── reapStuckPosts ────────────────────────────────────────────────────────
// Safety net: any post still IN_PROGRESS after STUCK_AFTER_MINUTES is marked
// FAILED (not re-queued) so it shows up in the dashboard's Notifications and
// can be retried by a person. Re-queueing automatically could publish the
// same post twice if n8n actually posted but failed to record it.
async function reapStuckPosts() {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString()

  try {
    const { data: stuck, error } = await supabase
      .from('posts')
      .select('id, client_id, topic, platforms')
      .eq('posting_status', 'IN_PROGRESS')
      .lt('updated_at', cutoff)

    if (error) {
      console.error('Stuck-post query error:', error.message)
      return
    }
    if (!stuck || stuck.length === 0) return

    for (const post of stuck) {
      // Re-check status AND age in the same statement, so a post that n8n
      // finished (or that was just re-claimed) a moment ago is left alone.
      const { data: flipped, error: updErr } = await supabase
        .from('posts')
        .update({ posting_status: 'FAILED', updated_at: new Date().toISOString() })
        .eq('id', post.id)
        .eq('posting_status', 'IN_PROGRESS')
        .lt('updated_at', cutoff)
        .select('id')

      if (updErr) {
        console.error(`Could not mark ${post.id} as FAILED:`, updErr.message)
        continue
      }
      if (!flipped || flipped.length === 0) continue

      console.warn(`⚠️  Marked stuck post as FAILED: "${post.topic}" (${post.id})`)

      // Best-effort: leave a reason the dashboard can show. Never let a
      // logging problem stop the sweep.
      try {
        const platform = (post.platforms || '').split(',')[0].trim().toLowerCase() || 'linkedin'
        const { error: logErr } = await supabase.from('error_logs').insert({
          client_id:     post.client_id,
          post_id:       post.id,
          node_name:     'scheduler',
          platform,
          error_message: `No result from n8n within ${STUCK_AFTER_MINUTES} minutes of starting. Check the platform to confirm it was not published, then retry.`,
        })
        if (logErr) console.error(`error_logs insert failed for ${post.id}:`, logErr.message)
      } catch (logEx) {
        console.error(`error_logs insert threw for ${post.id}:`, logEx.message)
      }
    }
  } catch (err) {
    console.error('Unexpected error in reapStuckPosts:', err.message)
  }
}

// ── checkDuePosts ─────────────────────────────────────────────────────────
async function checkDuePosts() {
  const now = new Date().toISOString()
  console.log(`[${now}] Checking for due posts…`)

  try {
    // Find posts that are PENDING and whose scheduled time has passed
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, topic, client_id, linkedin_scheduled_time, instagram_scheduled_time, twitter_scheduled_time, posting_status')
      .eq('posting_status', 'PENDING')
      .or(`linkedin_scheduled_time.lte.${now},instagram_scheduled_time.lte.${now},twitter_scheduled_time.lte.${now}`)

    if (error) {
      console.error('Supabase query error:', error.message)
      return
    }

    if (!posts || posts.length === 0) {
      console.log('No due posts found')
      return
    }

    console.log(`Found ${posts.length} due post(s)`)

    // Trigger n8n webhook for each post
    for (const post of posts) {
      try {
        // Mark as IN_PROGRESS first to prevent double-triggering
        await supabase
          .from('posts')
          .update({ posting_status: 'IN_PROGRESS', updated_at: new Date().toISOString() })
          .eq('id', post.id)

        const headers = {
          'Content-Type': 'application/json',
        }
        if (N8N_WEBHOOK_SECRET) {
          // Must match the header name in the n8n Header Auth credential bound to
          // the posting-trigger webhook (set N8N_WEBHOOK_HEADER, default "apikey").
          headers[N8N_WEBHOOK_HEADER] = N8N_WEBHOOK_SECRET
          headers['x-webhook-secret'] = N8N_WEBHOOK_SECRET
        }

        const res = await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            post_id:   post.id,
            client_id: post.client_id,
            topic:     post.topic,
          }),
        })

        if (res.ok) {
          console.log(`✅ Triggered posting for: "${post.topic}" (${post.id})`)
        } else {
          const text = await res.text().catch(() => '')
          console.error(`❌ n8n webhook failed for ${post.id}: ${res.status} ${text}`)
          // Reset back to PENDING so it retries next minute
          await supabase
            .from('posts')
            .update({ posting_status: 'PENDING' })
            .eq('id', post.id)
        }

      } catch (postError) {
        console.error(`Error processing post ${post.id}:`, postError.message)
        // Reset to PENDING on error
        await supabase
          .from('posts')
          .update({ posting_status: 'PENDING' })
          .eq('id', post.id)
      }
    }

  } catch (err) {
    console.error('Unexpected error in checkDuePosts:', err.message)
  }
}

// ── verifyHandoffs ────────────────────────────────────────────────────────
// n8n answers the webhook with 200 before it posts anything, so "triggered"
// does not mean "published". A few minutes after hand-off, compare what was
// due with what n8n recorded as posted. Any due platform still not posted is
// reported by name and the post is marked FAILED right away (not re-queued,
// so nothing can be published twice). A person can fix the cause and retry.
const PLATFORMS = [
  { key: 'linkedin',  label: 'LinkedIn',  match: 'linkedin' },
  { key: 'instagram', label: 'Instagram', match: 'instagram' },
  { key: 'twitter',   label: 'X',         match: 'twitter' },
]

function missedPlatforms(post, nowMs) {
  const wanted = (post.platforms || '').toLowerCase()
  const missed = []
  for (const p of PLATFORMS) {
    if (!wanted.includes(p.match)) continue
    const due = post[`${p.key}_scheduled_time`]
    if (!due || new Date(due).getTime() > nowMs) continue // not due yet
    if (String(post[`${p.key}_posted`] || '').toUpperCase() === 'YES') continue
    missed.push(p)
  }
  return missed
}

async function verifyHandoffs() {
  const cutoff = new Date(Date.now() - VERIFY_AFTER_MINUTES * 60_000).toISOString()
  try {
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, client_id, topic, platforms, updated_at, linkedin_scheduled_time, instagram_scheduled_time, twitter_scheduled_time, linkedin_posted, instagram_posted, twitter_posted')
      .eq('posting_status', 'IN_PROGRESS')
      .lt('updated_at', cutoff)

    if (error) {
      console.error('Verify query error:', error.message)
      return
    }
    if (!posts || posts.length === 0) return

    const nowMs = Date.now()
    for (const post of posts) {
      const missed = missedPlatforms(post, nowMs)
      if (missed.length === 0) continue // everything due was posted; leave status to n8n

      // Only flip if still IN_PROGRESS and untouched since we read it.
      const { data: flipped, error: updErr } = await supabase
        .from('posts')
        .update({ posting_status: 'FAILED', updated_at: new Date().toISOString() })
        .eq('id', post.id)
        .eq('posting_status', 'IN_PROGRESS')
        .eq('updated_at', post.updated_at)
        .select('id')

      if (updErr) {
        console.error(`Could not mark ${post.id} as FAILED:`, updErr.message)
        continue
      }
      if (!flipped || flipped.length === 0) continue

      const names = missed.map(m => m.label).join(', ')
      console.warn(`⚠️  n8n accepted but did not publish to ${names}: "${post.topic}" (${post.id})`)

      for (const m of missed) {
        try {
          const { error: logErr } = await supabase.from('error_logs').insert({
            client_id:     post.client_id,
            post_id:       post.id,
            node_name:     'scheduler',
            platform:      m.key,
            error_message: `n8n accepted the post but ${m.label} was not published within ${VERIFY_AFTER_MINUTES} minutes. Check the n8n execution for this post, confirm it is not on ${m.label}, then retry.`,
          })
          if (logErr) console.error(`error_logs insert failed for ${post.id}:`, logErr.message)
        } catch (logEx) {
          console.error(`error_logs insert threw for ${post.id}:`, logEx.message)
        }
      }
    }
  } catch (err) {
    console.error('Unexpected error in verifyHandoffs:', err.message)
  }
}

// ── Start ─────────────────────────────────────────────────────────────────
console.log('Content Engine Scheduler starting…')
console.log(`Checking every ${INTERVAL_MS / 1000}s`)
console.log(`Supabase: ${SUPABASE_URL}`)
console.log(`n8n webhook: ${N8N_WEBHOOK_URL}`)

// One tick = recover anything stuck, then trigger what is due.
async function tick() {
  await verifyHandoffs()
  await reapStuckPosts()
  await checkDuePosts()
}

console.log(`Stuck-post timeout: ${STUCK_AFTER_MINUTES} min, outcome check after ${VERIFY_AFTER_MINUTES} min`)

// Run immediately on start, then on interval
tick()
setInterval(tick, INTERVAL_MS)