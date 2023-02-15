import axios from 'axios';
import 'dotenv/config';

export async function sendNotification(content: string) {
    try {
        await axios.post(process.env.DISCORD_WEBHOOK_URL, {
            content,
        });
    } catch (err) {
        console.log('Error sending notification to Discord');
        console.error(err);
    }

    console.log(content);
};