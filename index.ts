// server.js
import 'dotenv/config';
import express, { Handler } from 'express';
import cors, { CorsOptions } from 'cors';
import { Client, GatewayIntentBits, TextChannel, EmbedBuilder, AttachmentBuilder } from 'discord.js'; // Import necessary classes
import multer from 'multer'; // <--- Require multer

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 8 * 1024 * 1024 } // Example: Limit file size to 8MB (Discord limit)
});

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const EXPECTED_SECRET = process.env.FOUNDRY_SECRET;
const TARGET_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!EXPECTED_SECRET || !TARGET_CHANNEL_ID || !BOT_TOKEN) {
    console.error("ERROR: Missing required environment variables (FOUNDRY_SECRET, DISCORD_CHANNEL_ID, BOT_TOKEN).");
    process.exit(1);
}

// --- Discord Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds // Only need Guilds intent to fetch channels
    ]
});

let discordReady = false; // Flag to track if Discord client is ready

client.once('ready', () => {
    console.log(`Discord client logged in as ${client.user?.tag}`);
    discordReady = true;
    // Optional: Fetch channel on ready to ensure it exists early?
    // client.channels.fetch(TARGET_CHANNEL_ID).catch(err => console.error("Error fetching target channel on ready:", err));
});

client.on('error', error => {
    console.error('Discord client error:', error);
});

// Log in the Discord client
client.login(BOT_TOKEN).catch(err => {
    console.error("Failed to log in Discord client:", err);
    process.exit(1);
});


// --- Express App Setup ---
const app = express();

const allowedOrigins = [
    'http://localhost:30000', // Default Foundry local host
    'https://your-foundry-domain.com' // Add the domain if you host Foundry elsewhere
    // Add any other origins Foundry might be accessed from
];
const corsOptions = {
    origin: (function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests) OR if origin is in allowed list
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.warn(`CORS blocked for origin: ${origin}`); // Log blocked origins
            callback(new Error('Not allowed by CORS'));
        }
    }) satisfies CorsOptions['origin'],
    methods: 'POST, OPTIONS', // Allow POST for your endpoint and OPTIONS for preflight requests
    allowedHeaders: 'Content-Type, Authorization' // Allow the headers your Foundry module sends
};
app.use(cors(corsOptions));

// Middleware to parse JSON bodies
app.use(express.json());

// --- Security Middleware ---
// Verify the shared secret from Foundry
const authenticateRequest = ((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn("Authentication failed: Missing or invalid Authorization header.");
        res.status(401).json({ error: 'Unauthorized: Missing authorization header' });
        return;
    }

    const providedSecret = authHeader.split(' ')[1];
    if (providedSecret !== EXPECTED_SECRET) {
        console.warn("Authentication failed: Invalid secret.");
        res.status(403).json({ error: 'Forbidden: Invalid secret' });
        return;
    }

    // If secrets match, proceed to the next handler
    next();
}) satisfies Handler;


// --- API Endpoint ---
// Define the endpoint that Foundry will call
app.post('/notify-achievement', authenticateRequest, upload.single('achievementImageFile'), async (req, res) => {
    if (!discordReady) {
        console.error("Discord client not ready, cannot send notification yet.");
        res.status(503).json({ error: 'Service Unavailable: Discord client not ready' });
        return;
    }

    // --- Access Data ---
    // JSON data sent as a string field needs parsing
    let payload;
    try {
        if (!req.body.jsonData) throw new Error('Missing jsonData field in request body.');
        payload = JSON.parse(req.body.jsonData);
    } catch (e) {
        console.warn("Failed to parse jsonData:", (e as Error).message, "Body:", req.body);
        res.status(400).json({ error: 'Bad Request: Invalid or missing jsonData field.' });
        return;
    }

    // The uploaded file details are in req.file (if upload was successful)
    const uploadedFile = req.file;

    const { userName, achievementName, achievementDescription, iconSource } = payload;

    // Basic validation
    if (!userName || !achievementName) {
        console.warn("Received invalid payload:", payload);
        res.status(400).json({ error: 'Bad Request: Missing userName or achievementName' });
        return;
    }

    console.log(`Received achievement notification for ${userName} - ${achievementName}`);
    if (uploadedFile) {
        console.log(`Received file: ${uploadedFile.originalname}, size: ${uploadedFile.size}, type: ${uploadedFile.mimetype}`);
    } else {
        console.log("No file uploaded with this request.");
    }


    try {
        // Fetch the target Discord channel
        const channel = await client.channels.fetch(TARGET_CHANNEL_ID);

        if (!channel || !(channel instanceof TextChannel)) {
            // ... (keep channel validation) ...
            res.status(500).json({ error: 'Internal Server Error: Could not find or use target Discord channel' });
            return;
        }

        // --- Create the Discord Message ---
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🏆 Achievement Unlocked! 🎉')
            .setDescription(`**${userName}** has unlocked the achievement: **${achievementName}**!`)
            .setTimestamp(new Date());

        if (achievementDescription) {
            embed.addFields({ name: 'Description', value: achievementDescription });
        }

        // Prepare files to attach (if one was uploaded)
        const filesToAttach = [];
        if (uploadedFile) {
            // Use AttachmentBuilder for clarity
            const attachment = new AttachmentBuilder(uploadedFile.buffer, { name: uploadedFile.originalname || `achievement-${achievementName}.png` }); // Use original name or generate one
            filesToAttach.push(attachment);
            // You might want the embed to reference the attached image
            embed.setImage(`attachment://${attachment.name}`); // Reference attached file in embed
            // Or use setThumbnail if more appropriate size-wise
            // embed.setThumbnail(`attachment://${attachment.name}`);
        } else if (iconSource && (iconSource.startsWith('http://') || iconSource.startsWith('https://'))) {
            // Fallback: If no file was uploaded but we have a valid URL from the payload, use it
            console.log("No file uploaded, using iconSource URL as thumbnail:", iconSource);
            embed.setThumbnail(iconSource);
        }


        // --- Send the message with potential attachments ---
        await channel.send({ embeds: [embed], files: filesToAttach }); // Send embeds AND files array

        console.log(`Successfully sent notification for ${userName} to Discord channel ${TARGET_CHANNEL_ID}`);
        res.status(200).json({ message: 'Notification sent successfully' });
    } catch (error) {
        console.error(`Error processing notification or sending to Discord for ${userName}:`, error);
        res.status(500).json({ error: 'Internal Server Error: Failed to send Discord notification' });
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Achievement Discord Backend listening on port ${PORT}`);
    console.log(`Expecting requests at /notify-achievement`);
});