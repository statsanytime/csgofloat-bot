import TradeOfferManager from 'steam-tradeoffer-manager';
import { client, manager, sendOffer, cancelOffer, login as loginSteam } from './steam.js';
import { sendNotification } from './notifications.js';
import { retry } from './utils.js';
import HttpsProxyAgent, { HttpsProxyAgentOptions } from 'https-proxy-agent';
import fetch, { RequestInit, RequestInfo } from 'node-fetch';
import 'dotenv/config';

interface TradeToSendBuyer {
    avatar: string;
    away: boolean;
    flags: number;
    online: boolean;
    stall_public: boolean;
    statistics: {
        median_trade_time: number;
        total_avoided_trades: number;
        total_failed_trades: number;
        total_trades: number;
        total_verified_trades: number;
    };
    steam_id: string;
    username: string;
};

interface FloatMe {
    pending_offers: number;
    trades_to_send: TradeToSend[];
    user: {
        [key: string]: any;
    };
};

interface TradeToSend {
    id: string;
    created_at: string;
    buyer_id: string;
    buyer: TradeToSendBuyer;
    seller_id: string;
    contract_id: string;
    state: string;
    manual_verification: boolean;
    manual_verification_at: string;
    expires_at: string|null;
    grace_period_start: string|null;
    contract: {
        id: string;
        created_at: string;
        type: string;
        price: number;
        state: string;
        item: {
            asset_id: string;
            def_index: number;
            paint_index: number;
            paint_seed: number;
            float_value: number;
            icon_url: string;
            d_param: string;
            is_stattrak: boolean;
            is_souvenir: boolean;
            rarity: number;
            quality: number;
            market_hash_name: string;
            tradable: number;
            inspect_link: string;
            has_screenshot: boolean;
            scm: {
                price: number;
                volume: number;
            };
            item_name: string;
            wear_name: string;
            description: string;
            collection: string;
            badges: any[];
        };
        is_seller: boolean;
        is_watchlisted: boolean;
        watchers: number;
    };
    trade_url: string;
};

interface SentOffer {
    offer: TradeOfferManager.TradeOffer;
    trade: TradeToSend;
    timeout: NodeJS.Timeout|null;
    asset_id: string;
};

let sentOffers: SentOffer[] = [];

function fetchFloat(url: RequestInfo, options: RequestInit = {}) {
    if (process.env.PROXY_HOST) {
        const proxyOptions: HttpsProxyAgentOptions = {
            host: process.env.PROXY_HOST,
            port: process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT) : 443,
            protocol: process.env.PROXY_PROTOCOL || 'https:',
        };

        if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
            proxyOptions.auth = `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}`;
        }

        // @ts-ignore
        const proxyAgent = new HttpsProxyAgent(proxyOptions);

        options.agent = proxyAgent;
    }

    options.headers = {
        ...options.headers,
        Authorization: process.env.CSGOFLOAT_API_KEY,
    };

    return fetch(`https://csgofloat.com/api/v1${url}`, options);
}

async function acceptTrade(trade: TradeToSend) {
    return fetchFloat(`/trades/${trade.id}/accept`, {
        method: 'POST',
    });
}

async function handleOfferAccepted(offer: TradeOfferManager.TradeOffer) {
    let data = sentOffers.find((data: SentOffer) => data.offer.id === offer.id);

    // cancel cancel timeout
    clearTimeout(data.timeout);

    sendNotification(`Offer accepted for ${data.trade.contract.item.market_hash_name} and trade ${data.trade.id} is now completed.`);

    // remove it since it's completed, but wait 5 minutes so that csgofloat has time to update the trade
    setTimeout(() => {
        sentOffers = sentOffers.filter((data: SentOffer) => data.offer.id !== offer.id);
    }, 300000);
}

async function handleSentTrade(trade: TradeToSend, offer: TradeOfferManager.TradeOffer) {
    sentOffers.push({
        offer,
        trade,
        timeout: null,
        asset_id: trade.contract.item.asset_id,
    });

    sendNotification(`Offer sent for ${trade.contract.item.market_hash_name} to ${trade.buyer.username}`);
}

async function handleTradeToSend(trade: TradeToSend) {
    if (trade.state === 'queued') {
        try {
            await retry(() => acceptTrade(trade), 3, 5000);

            trade.state = 'pending';
        } catch (err) {
            sendNotification('Error while accepting trade.');
            console.error(err);

            return;
        }
    }

    if (trade.state === 'pending') {
        const offer = manager.createOffer(trade.trade_url);

        offer.addMyItems([{
            assetid: trade.contract.item.asset_id,
            appid: 730,
            contextid: 2,
        }]);

        sendOffer(offer)
        .then((offer: TradeOfferManager.TradeOffer) => handleSentTrade(trade, offer))
        .catch((err: any) => {
            sendNotification('Error sending offer');
            console.error(err);
        });
    }
}

function checkForTradesToSend() {
    fetchFloat('/me')
    .then(async res => {
        let data = await res.json() as FloatMe;

        let tradesToSend: TradeToSend[] = data.trades_to_send.filter((trade: TradeToSend) => !sentOffers.some((data: SentOffer) => data.trade.id === trade.id));
        let tradesToSendWithGracePeriod = tradesToSend.filter((trade: TradeToSend) => trade.grace_period_start);

        tradesToSend.forEach(handleTradeToSend);

        tradesToSendWithGracePeriod.forEach((trade: TradeToSend) => {
            let timeLeftTilGrace = new Date(trade.grace_period_start).getMilliseconds() - new Date().getMilliseconds();
            let offerData = sentOffers.find((data: SentOffer) => data.trade.id === trade.id);

            if (!offerData) {
                return;
            }

            let timeout = setTimeout(() => {
                cancelOffer(offerData.offer)
                .then(() => {
                    sendNotification(`Cancelled trade ${trade.id} as grace period has started.`);
                })
                .catch((err: any) => {
                    sendNotification(err.message || `Error cancelling trade ${trade.id}. Please cancel it manually.`);
                    console.error(err);
                });
            }, timeLeftTilGrace);
        
            let index = sentOffers.findIndex((data: SentOffer) => data.trade.id === trade.id);

            sentOffers[index].timeout = timeout;
        });
    })
    .catch((err: any) => {
        sendNotification('Error while getting trades to send.');
        console.error(err);
    });
};

loginSteam();

// Wait for the client to log on to Steam before checking for trades to send
client.on('webSession', () => {
    // Fetch trades to send every minute
    setInterval(checkForTradesToSend, 1000 * 60);

    // Run once on startup
    checkForTradesToSend();
});

manager.on('sentOfferChanged', function(offer: TradeOfferManager.TradeOffer) {
    if (offer.state == TradeOfferManager.ETradeOfferState.Accepted && sentOffers.some((data: SentOffer) => data.offer.id === offer.id)) {
        handleOfferAccepted(offer);
    }
});
