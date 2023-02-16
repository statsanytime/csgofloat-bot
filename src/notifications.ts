import fetch from 'node-fetch';
import 'dotenv/config';

export async function sendNotification(content: string) {
    try {
        await fetch(process.env.DISCORD_WEBHOOK_URL, {
            body: JSON.stringify({
                content,
            }),
            method: 'POST',
        });
    } catch (err) {
        console.log('Error sending notification to Discord');
        console.error(err);
    }

    console.log(content);
};