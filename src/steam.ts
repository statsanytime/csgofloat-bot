// @ts-ignore
import SteamUser from 'steam-user';
// @ts-ignore
import SteamTotp from 'steam-totp';
// @ts-ignore
import SteamCommunity from 'steamcommunity';
// @ts-ignore
import TradeOfferManager from 'steam-tradeoffer-manager';
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from 'steam-session';
import { readFileSync, writeFileSync } from 'fs';
import { sendNotification } from './notifications.js';
import { retry } from './utils.js';
import util from 'util';
import 'dotenv/config';

interface SentTradeOffers {
    [key: string]: TradeOfferManager.TradeOffer,
}

interface Secrets {
    refresh_token: string|null,
}

const sentTradeOffers: SentTradeOffers = {};

const client = new SteamUser();

const community = new SteamCommunity();

const manager = new TradeOfferManager({
	steam: client,
    community,
	language: "en"
});

let secrets: Secrets = getSecrets();

function getSecretsFromFile(): Secrets|null {
    try {
        let secretsFile = JSON.parse(readFileSync('secrets.json', 'utf8'));

        return secretsFile;
    } catch (err) {
        return null;
    }
}

function getSecrets(): Secrets {
    if (process.env.CACHE_SECRETS === 'true') {
        sendNotification('Getting secrets from cache');

        let secretsFile = getSecretsFromFile();

        if (secretsFile) {
            return secretsFile;
        }
    }

    return {
        refresh_token: null,
    };
}

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

function updateSecrets(attributes: { [key: string]: any }) {
    secrets = {
        ...secrets,
        ...attributes,
    };

    writeFileSync('secrets.json', JSON.stringify(secrets));

    return secrets;
}

async function getRefreshToken(): Promise<string> {
    if (secrets.refresh_token) {
        return secrets.refresh_token;
    }

    return new Promise(async (resolve, reject) => {
        let session = await getSession();
        
        session.on('authenticated', async () => {
            sendNotification('Steam session authenticated');

            let updatedSecrets = updateSecrets({
                refresh_token: session.refreshToken,
            });
        
            return resolve(updatedSecrets.refresh_token);
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

async function login() {
    client.logOn({
        refreshToken: await getRefreshToken(),
    });

    client.on('loggedOn', () => {
        sendNotification('Logged into Steam');
    });
    
    client.on('webSession', (sessionID: any, cookies: any) => {
        sendNotification('Got web session');
    
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

    community.on('sessionExpired', async function(err: any) {
        sendNotification('Steam session expired');
        console.error(err);

        client.logOn({
            refreshToken: await getRefreshToken(),
        });
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