const { createClient } = require('@supabase/supabase-js')

// ── Config ────────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const N8N_WEBHOOK_URL     = process.env.N8N_WEBHOOK_URL
const N8N_WEBHOOK_SECRET  = process.env.N8N_WEBHOOK_SECRET
const INTERVAL_MS         = 60_000 // run every 60 seconds

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !N8N_WEBHOOK_URL) {
  console.error('Missing required environment variables')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

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
          .update({ posting_status: 'IN_PROGRESS' })
          .eq('id', post.id)

        const headers = {
          'Content-Type': 'application/json',
        }
        if (N8N_WEBHOOK_SECRET) {
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

// ── Start ─────────────────────────────────────────────────────────────────
console.log('Content Engine Scheduler starting…')
console.log(`Checking every ${INTERVAL_MS / 1000}s`)
console.log(`Supabase: ${SUPABASE_URL}`)
console.log(`n8n webhook: ${N8N_WEBHOOK_URL}`)

// Run immediately on start, then on interval
checkDuePosts()
setInterval(checkDuePosts, INTERVAL_MS)