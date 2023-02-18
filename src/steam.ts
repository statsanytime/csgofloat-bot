// @ts-ignore
import SteamUser from 'steam-user';
// @ts-ignore
import SteamTotp from 'steam-totp';
// @ts-ignore
import SteamCommunity from 'steamcommunity';
// @ts-ignore
import TradeOfferManager from 'steam-tradeoffer-manager';
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from 'steam-session';
import { sendNotification } from './notifications.js';
import { retry } from './utils.js';
import util from 'util';
import 'dotenv/config';

interface SentTradeOffers {
    [key: string]: TradeOfferManager.TradeOffer,
}

const sentTradeOffers: SentTradeOffers = {};

const client: SteamUser = new SteamUser();

const community: SteamCommunity = new SteamCommunity();

const manager: TradeOfferManager = new TradeOfferManager({
	steam: client,
    community,
	language: "en"
});

async function getSession(): Promise<LoginSession> {
    let session = new LoginSession(EAuthTokenPlatformType.SteamClient);

    let startResult = await session.startWithCredentials({
        accountName: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD,
    });

    sendNotification('Steam session started');

	if (startResult.actionRequired) {
        if (!startResult.validActions.some(action => action.type === EAuthSessionGuardType.DeviceCode)) {
            throw new Error('Device code is not a valid action for signing in.');
        }

        let code = SteamTotp.getAuthCode(process.env.STEAM_SHARED_SECRET);

        await session.submitSteamGuardCode(code);

        sendNotification('Steam guard code submitted and session was successfully created.');
    }

    return session;
}

async function authenticateSession(session: LoginSession): Promise<LoginSession> {
    return new Promise(async (resolve, reject) => {
        session.on('authenticated', async () => {
            sendNotification('Steam session authenticated');
        
            return resolve(session);
        });

        session.on('timeout', () => {
            sendNotification('Steam session timed out');

            reject('Steam session timed out');
        });
    
        session.on('error', (err: any) => {
            sendNotification(`Steam session error: ${err.message}`);

            reject(err);
        });
    });
}

async function refreshWebCookies(session: LoginSession) {
    let webCookies = await session.getWebCookies();

    let managerSetCookiesFn = util.promisify(manager.setCookies.bind(manager));

    try {
        await managerSetCookiesFn(webCookies);
        sendNotification('Web cookies set');
    } catch (err) {
        sendNotification('Unable to set cookies for trade offer manager');
        console.error(err);
        process.exit(1);
    }
}

async function login() {
    let session = await getSession();

    await authenticateSession(session);

    client.logOn({
        refreshToken: session.refreshToken,
    });

    client.on('loggedOn', async () => {
        sendNotification('Logged into Steam');

        await refreshWebCookies(session);
    });

    community.on('sessionExpired', async function(err: any) {
        sendNotification('Steam session expired');
        console.error(err);

        await refreshWebCookies(session);
    });
}

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

    return offer;
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
    login,
};