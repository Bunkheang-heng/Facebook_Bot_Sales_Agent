/**
 * Telegram Bot Setup Script
 * 
 * This script helps you set up your Telegram webhook quickly
 */

const https = require('https');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in .env file');
  process.exit(1);
}

console.log('🤖 Telegram Bot Setup\n');
console.log(`Bot Token: ${BOT_TOKEN.substring(0, 10)}...${BOT_TOKEN.substring(BOT_TOKEN.length - 4)}\n`);

// Function to make Telegram API request
function telegramRequest(method, data = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.ok) {
            resolve(response.result);
          } else {
            reject(new Error(response.description || 'API request failed'));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Main setup function
async function setupTelegram() {
  try {
    // Step 1: Get bot info
    console.log('📋 Step 1: Getting bot info...');
    const botInfo = await telegramRequest('getMe');
    console.log(`✅ Bot Name: @${botInfo.username}`);
    console.log(`   First Name: ${botInfo.first_name}`);
    console.log(`   Bot ID: ${botInfo.id}\n`);

    // Step 2: Check current webhook
    console.log('🔍 Step 2: Checking current webhook...');
    const webhookInfo = await telegramRequest('getWebhookInfo');
    
    if (webhookInfo.url) {
      console.log(`   Current webhook: ${webhookInfo.url}`);
      console.log(`   Pending updates: ${webhookInfo.pending_update_count || 0}\n`);
    } else {
      console.log('   No webhook currently set\n');
    }

    // Step 3: Instructions
    console.log('📝 Step 3: Setup Instructions\n');
    console.log('To complete setup, you need to:');
    console.log('\n1️⃣  Expose your local server using ngrok (or similar):');
    console.log('   npm install -g ngrok');
    console.log('   ngrok http 3001\n');
    
    console.log('2️⃣  Set the webhook URL (replace YOUR_NGROK_URL):');
    console.log(`   curl -X POST https://api.telegram.org/bot${BOT_TOKEN}/setWebhook \\`);
    console.log('        -H "Content-Type: application/json" \\');
    console.log('        -d \'{"url":"https://YOUR_NGROK_URL/telegram/webhook"}\'\n');
    
    console.log('   OR use this Node.js command:');
    console.log('   node -e "require(\'https\').request({');
    console.log('     hostname: \'api.telegram.org\',');
    console.log(`     path: \'/bot${BOT_TOKEN}/setWebhook\',`);
    console.log('     method: \'POST\',');
    console.log('     headers: {\'Content-Type\': \'application/json\'}');
    console.log('   }, res => res.on(\'data\', d => console.log(d.toString())))');
    console.log('   .end(JSON.stringify({url: \'https://YOUR_NGROK_URL/telegram/webhook\'}))"\n');

    console.log('3️⃣  Test your bot:');
    console.log(`   Open Telegram and search for @${botInfo.username}`);
    console.log('   Send a message: "Hi"\n');

    console.log('4️⃣  Optional - Add a secret token for security:');
    console.log('   Add TELEGRAM_SECRET_TOKEN=your_random_secret to .env');
    console.log('   Then set webhook with secret_token parameter\n');

    console.log('💡 Quick Test (delete webhook to use polling):');
    console.log('   If you want to delete the webhook:');
    console.log(`   curl https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook\n`);

    console.log('✨ Ready to go! Your server is listening on port 3001');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Helper function to set webhook from command line
async function setWebhookFromCLI() {
  const webhookUrl = process.argv[2];
  
  if (!webhookUrl) {
    console.error('❌ Please provide webhook URL as argument');
    console.log('Usage: node setup-telegram.js https://your-domain.com/telegram/webhook');
    process.exit(1);
  }

  if (!webhookUrl.startsWith('https://')) {
    console.error('❌ Webhook URL must use HTTPS');
    process.exit(1);
  }

  try {
    console.log(`🔗 Setting webhook to: ${webhookUrl}\n`);
    
    const result = await telegramRequest('setWebhook', {
      url: webhookUrl,
      max_connections: 40,
      allowed_updates: ['message', 'callback_query']
    });

    console.log('✅ Webhook set successfully!');
    console.log(`   URL: ${webhookUrl}`);
    console.log(`   Response: ${JSON.stringify(result, null, 2)}\n`);
    
    // Verify
    const webhookInfo = await telegramRequest('getWebhookInfo');
    console.log('📋 Webhook Info:');
    console.log(`   URL: ${webhookInfo.url}`);
    console.log(`   Pending Updates: ${webhookInfo.pending_update_count || 0}`);
    console.log(`   Last Error: ${webhookInfo.last_error_message || 'None'}\n`);

    const botInfo = await telegramRequest('getMe');
    console.log(`🤖 Ready! Send a message to @${botInfo.username} to test`);

  } catch (error) {
    console.error('❌ Error setting webhook:', error.message);
    process.exit(1);
  }
}

// Run the appropriate function
if (process.argv.length > 2) {
  setWebhookFromCLI();
} else {
  setupTelegram();
}

