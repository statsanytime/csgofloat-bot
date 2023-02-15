// @ts-ignore
import SteamUser from 'steam-user';
// @ts-ignore
import SteamTotp from 'steam-totp';
// @ts-ignore
import SteamCommunity from 'steamcommunity';
// @ts-ignore
import TradeOfferManager from 'steam-tradeoffer-manager';
import { sendNotification } from './notifications.js';
import { retry } from './utils.js';
import util from 'util';
import 'dotenv/config';

interface SentTradeOffers {
    [key: string]: TradeOfferManager.TradeOffer,
}

const sentTradeOffers: SentTradeOffers = {};

let client = new SteamUser();

let manager = new TradeOfferManager({
	"steam": client,
	"language": "en"
});

let community = new SteamCommunity();

let logOnOptions = {
    "accountName": process.env.STEAM_USERNAME,
    "password": process.env.STEAM_PASSWORD,
    "twoFactorCode": SteamTotp.getAuthCode(process.env.STEAM_SHARED_SECRET)
};

client.logOn(logOnOptions);

client.on('loggedOn', () => {
    sendNotification('Logged into Steam');
});

client.on('webSession', (sessionID: any, cookies: any) => {
    manager.setCookies(cookies, (err: any) => {
        if (err) {
            sendNotification('Unable to set cookies for trade offer manager');
            console.error(err);
            process.exit(1);
        }

        sendNotification('Trade offer manager cookies set');
    });

    community.setCookies(cookies);
});

community.on('sessionExpired', function(err: any) {
    sendNotification('Steam session expired');
    console.error(err);

    client.webLogOn();
});

export async function sendOffer(offer: TradeOfferManager.TradeOffer) {
    let sendTradeOfferPromiseFn = util.promisify(offer.send.bind(offer));

    let status = await retry(() => sendTradeOfferPromiseFn(), 3, 5000);

    sentTradeOffers[offer.id] = offer;

    sendNotification(`Sent offer. Status: ${status}.`);

    if (status === 'pending') {
        sendNotification(`Offer #${offer.id} needs confirmation.`);

        let confirmPromiseFn = util.promisify(community.acceptConfirmationForObject.bind(community));

        await retry(() => confirmPromiseFn(process.env.STEAM_IDENTITY_SECRET, offer.id), 3, 5000);

        sentTradeOffers[offer.id] = offer;

        sendNotification(`Offer ${offer.id} confirmed`);
    }
}

export function getOffer(offerId: string): Promise<TradeOfferManager.TradeOffer|null> {
    let cached = sentTradeOffers[offerId];

    if (cached) {
        return cached;
    }

    return new Promise((resolve, reject) => {
        manager.getOffer(offerId, (err: any, offer: TradeOfferManager.TradeOffer) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(offer);
        });
    });
}

export async function cancelOffer(offerId: string) {
    return new Promise((resolve, reject) => {
        getOffer(offerId)
            .then((offer: TradeOfferManager.TradeOffer) => {
                if (!offer) {
                    reject(`Offer ${offerId} could not be found and therefore cannot be cancelled. Please cancel it manually.`);
                    return;
                }

                offer.cancel((err: any) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    delete sentTradeOffers[offerId];
                    resolve(offer);
                });
            }).catch((err: any) => {
                reject(err);
            });
    });
}

export {
    manager,
    community,
    client,
};