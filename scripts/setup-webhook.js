// scripts/setup-webhook.js
const https = require('https');

const fs = require('fs');
const path = require('path');

// Load environment variables from .env file if it exists
try {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split('\n').forEach(line => {
            const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (match) {
                const key = match[1];
                let value = match[2] || '';
                if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
                process.env[key] = value;
            }
        });
    }
} catch (err) {
    console.warn('Could not load .env file:', err.message);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const args = process.argv.slice(2);
const command = args[0]; // 'set', 'get', 'delete'
const url = args[1];

async function callTelegram(method, params = {}) {
    return new Promise((resolve, reject) => {
        const apiUrl = `${TELEGRAM_API}/${method}`;
        const data = JSON.stringify(params);

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = https.request(apiUrl, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

async function main() {
    if (!command || !['set', 'get', 'delete'].includes(command)) {
        console.log('Usage: node setup-webhook.js <command> [url]');
        console.log('Commands: set, get, delete');
        process.exit(1);
    }

    try {
        if (command === 'get') {
            const info = await callTelegram('getWebhookInfo');
            const me = await callTelegram('getMe');
            console.log('Bot Info:', JSON.stringify(me.result, null, 2));
            console.log('Webhook Info:', JSON.stringify(info.result, null, 2));
        } else if (command === 'set') {
            if (!url) {
                console.error('URL is required for "set" command');
                process.exit(1);
            }
            const res = await callTelegram('setWebhook', { 
                url,
                allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member", "poll_answer"]
            });
            console.log('Set Webhook Result:', JSON.stringify(res, null, 2));
            
            console.log('Verifying immediately...');
            const info = await callTelegram('getWebhookInfo');
            console.log('Webhook Info after set:', JSON.stringify(info.result, null, 2));
        } else if (command === 'delete') {
            const res = await callTelegram('deleteWebhook');
            console.log('Delete Webhook Result:', JSON.stringify(res, null, 2));
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}

main();
