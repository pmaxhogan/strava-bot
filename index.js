import fetch from "node-fetch";
import express from "express";
import bodyParser from "body-parser";
import * as fs from "fs";
import "dotenv/config";
import {ActionRowBuilder, EmbedBuilder, REST, Routes} from "discord.js";
import {Client, GatewayIntentBits, ButtonBuilder, ButtonStyle} from 'discord.js';
import {createServer} from "https";

const client = new Client({intents: [GatewayIntentBits.Guilds]});
const app = express().use(bodyParser.json());
const stravaClientId = process.env.STRAVA_CLIENT_ID;
const stravaClientSecret = process.env.STRAVA_CLIENT_SECRET;
const stravaToken = process.env.STRAVA_TOKEN;
const urlBase = process.env.URL_BASE;
const discordBotToken = process.env.DISCORD_BOT_TOKEN;
const discordClientId = process.env.DISCORD_CLIENT_ID;
const discordChannelId = process.env.DISCORD_CHANNEL_ID;

const configFile = "config.json";
let config = {};
try {
    config = JSON.parse(fs.readFileSync(configFile).toString());
} catch (e) {
    fs.writeFileSync(configFile, JSON.stringify({}));
}
const writeConfig = () => fs.writeFileSync(configFile, JSON.stringify(config));

const getUserInfo = async (stravaUserId) => {
    config[stravaUserId] = config[stravaUserId] || {};
    return config[stravaUserId];
};

const setUserInfo = async (stravaUserId, info) => {
    config[stravaUserId] = info;
    writeConfig();
};

const getStravaIdOfDiscordId = async (discordId) => {
    for (const stravaId of Object.keys(config)) {
        if (config[stravaId].discordId === discordId) {
            return stravaId;
        }
    }
    throw new Error("No Strava account linked");
}


const getAuthorizeUrl = (token) => `https://www.strava.com/oauth/authorize?client_id=${stravaClientId}&response_type=code&redirect_uri=${urlBase}/callback&approval_prompt=auto&scope=activity:read,profile:read_all,read&state=${token}`;
const getDiscordOAuthUrl = () => `https://discord.com/api/oauth2/authorize?client_id=${discordClientId}&scope=bot%20applications.commands&permissions=2147486720`;

const commands = [{
    name: "link", description: "Link your Strava!",
}, {
    name: "unlink", description: "Unlink your Strava!",
}];

const rest = new REST({version: "10"}).setToken(discordBotToken);

try {
    await rest.put(Routes.applicationCommands(discordClientId), {body: commands});
} catch (error) {
    console.error(error);
}

client.on("ready", () => {
    console.log(`Logged in as ${client.user.tag}! ${getDiscordOAuthUrl()}`);
});

const tokenMap = {};

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.channelId !== discordChannelId) {
        await interaction.reply({
            content: `Please use this command in <#${discordChannelId}>`, ephemeral: true,
        });
        return;
    }

    if (interaction.commandName === "link") {
        const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        tokenMap[token] = interaction.user.id;

        const row = new ActionRowBuilder();
        row.addComponents((new ButtonBuilder())
            .setLabel("Link Strava")
            .setStyle("Link")
            .setURL(getAuthorizeUrl(token)));

        await interaction.reply({
            components: [row], content: "Link Strava", ephemeral: true,
        });
    } else if (interaction.commandName === "unlink") {
        try {
            const stravaId = await getStravaIdOfDiscordId(interaction.user.id);

            await fetchRefreshIfNeeded(stravaId, "https://www.strava.com/oauth/deauthorize", {
                method: "POST",
            }, true);

            await setUserInfo(stravaId, {});

            await interaction.reply({
                content: "Unlinked Strava", ephemeral: true,
            });

        } catch (e) {
            console.error(e);
            await interaction.reply({
                content: "Unable to unlink Strava.", ephemeral: true,
            });
        }
    }
});

client.login(discordBotToken);

if(process.env.HTTPS_KEY){
    createServer({
        key: fs.readFileSync(process.env.HTTPS_KEY),
        cert: fs.readFileSync(process.env.HTTPS_CERT),
    }, app).listen(process.env.PORT || 8080, () => console.log("Server ready"));
}else{
    app.listen(process.env.PORT || 8080, () => console.log("Server ready"));
}

app.post("/webhook", async (req, res) => {
    const {aspect_type, object_id, object_type, owner_id} = req.body;
    if (object_type === "activity" && aspect_type === "create") {
        try {
            await processActivity(owner_id, object_id);
        } catch (e) {
            console.error(e);
        }
    }

    res.status(200).send("EVENT_RECEIVED");
});


async function refresh(athleteId) {
    const refresh_token = (await getUserInfo(athleteId)).refreshToken;
    console.log("refreshing token", athleteId, refresh_token);

    const req = await fetch("https://www.strava.com/oauth/token", {
        method: "POST", headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        }, body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: stravaClientId.toString(),
            client_secret: stravaClientSecret,
            refresh_token
        }).toString()
    });
    const json = await req.json();
    if (req.status !== 200) {
        throw new Error(`Failed to refresh token: ${JSON.stringify(json)}`);
    }

    await setUserInfo(athleteId, {
        accessToken: json.access_token, refreshToken: json.refresh_token, ...await getUserInfo(athleteId)
    });
}

async function fetchRefreshIfNeeded(athleteId, url, opts, dontRefresh = false) {
    const {accessToken} = await getUserInfo(athleteId);

    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers["Authorization"] = `Bearer ${accessToken}`;

    const req = await fetch(url, opts);
    if (req.status === 401) {
        if (dontRefresh) {
            return null;
        } else {
            await refresh(athleteId);
            return await fetchRefreshIfNeeded(athleteId, url, opts, true);
        }
    }
    return req;
}

const camelCaseToNormal = (str) => str.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`).trim();
const mToMi = (m) => (m * 0.000621371).toFixed(2);
const mToFt = (m) => (m * 3.28084).toFixed(2);
const mpsToMph = (mps) => (mps * 2.23694).toFixed(2);
const format2LeadingZeros = (num) => num.toString().padStart(2, "0");
const formatTime = time => `${Math.floor(time / (60 * 60))}:${format2LeadingZeros(Math.floor(time / 60) % 60)}:${format2LeadingZeros(time % 60)}`;

const processActivity = async (athleteId, activityId) => {
    console.log("activity", athleteId, activityId);
    const activityReq = await fetchRefreshIfNeeded(athleteId, `https://www.strava.com/api/v3/activities/${activityId}`, {
        headers: {
            "Accept": "application/json",
        },
    });
    const activityJson = await activityReq.json();

    const {discordId, photo} = await getUserInfo(athleteId);
    const {
        sport_type,
        name,
        distance,
        moving_time,
        elapsed_time,
        total_elevation_gain,
        average_speed,
        max_speed,
        average_heartrate,
        max_heartrate,
        start_date,
        average_watts,
        weighted_average_watts,
        calories,
        description
    } = activityJson;


    if (discordId) {
        const fields = [distance && {
            name: "Distance", value: `${mToMi(distance)} mi`,
        }, moving_time && {
            name: "Moving Time", value: formatTime(moving_time),
        }, elapsed_time && {
            name: "Elapsed Time", value: formatTime(elapsed_time),
        }, total_elevation_gain && {
            name: "Elevation Gain", value: `${mToFt(total_elevation_gain)} ft`,
        }, average_speed && {
            name: "Average Speed", value: `${mpsToMph(average_speed)} mph`,
        }, max_speed && {
            name: "Max Speed", value: `${mpsToMph(max_speed)} mph`,
        }, average_heartrate && {
            name: "Average Heartrate", value: `${average_heartrate} bpm`,
        }, max_heartrate && {
            name: "Max Heartrate", value: `${max_heartrate} bpm`,
        }, calories && {
            name: "Calories", value: `${calories} kcal`,
        }, average_watts && {
            name: "Average Watts", value: `${average_watts} W`,
        }, weighted_average_watts && {
            name: "Normalized Power", value: `${weighted_average_watts} W`,
        },].filter(Boolean).map(field => ({...field, inline: true}));

        const link = `https://www.strava.com/activities/${activityId}`;

        // noinspection JSCheckFunctionSignatures
        const linkedEmbed = new EmbedBuilder()
            .setColor(0x63fc30)
            .setTitle(name)
            .setDescription(`<@${discordId}> uploaded [a ${camelCaseToNormal(sport_type)}](${link})! Give them Kudos!\n\n${description}`)
            .setTimestamp(new Date(start_date))
            .setURL(link)
            .setFooter({text: "Link your Strava with /link"})
            .setImage(photo)
            .addFields(...fields);

        const row = new ActionRowBuilder();
        row.addComponents((new ButtonBuilder())
            .setLabel("Strava")
            .setStyle("Link")
            .setURL(link));


        const channel = await client.channels.fetch(discordChannelId);
        await channel.send({
            embeds: [linkedEmbed], components: [row],
        });
    }
}


app.get("/webhook", (req, res) => {
    let mode = req.query["hub.mode"];
    let token = req.query["hub.verify_token"];
    let challenge = req.query["hub.challenge"];
    if (mode && token) {
        if (mode === "subscribe" && token === stravaToken) {
            res.json({"hub.challenge": challenge});
        } else {
            console.log("token no match");
            res.sendStatus(403);
        }
    }
});

app.get("/authorize", (req, res) => {
    const {token} = req.query;

    const url = getAuthorizeUrl(token);
    res.redirect(url);
});

app.get("/callback", async (req, res) => {
    const {code, state} = req.query;

    const discordId = tokenMap[state];
    delete tokenMap[state];

    if (!discordId) {
        res.status(500).send("Invalid token");
        return;
    }

    const tokenReq = await fetch("https://www.strava.com/api/v3/oauth/token", {
        method: "POST", headers: {
            "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
        }, body: new URLSearchParams({
            client_id: stravaClientId.toString(),
            client_secret: stravaClientSecret,
            code: code,
            grant_type: "authorization_code",
        })
    });
    const tokenJson = await tokenReq.json();

    await setUserInfo(tokenJson.athlete.id.toString(), {
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token,
        photo: tokenJson.athlete.profile,
        discordId, ...await getUserInfo(tokenJson.athlete.id.toString()),
    });

    // noinspection JSCheckFunctionSignatures
    const linkedEmbed = new EmbedBuilder()
        .setColor(0x63fc30)
        .setTitle("Strava Linked")
        .setDescription(`Successfully linked <@${discordId}>'s [Strava account](https://www.strava.com/athletes/${tokenJson.athlete.id})  🎉`)
        .setFooter({text: "Link your Strava with /link"})
        .setTimestamp();


    const channel = await client.channels.fetch(discordChannelId);
    await channel.send({embeds: [linkedEmbed]});

    res.send("ok");
});


