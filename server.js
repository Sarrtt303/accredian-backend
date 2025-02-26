require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { PrismaClient } = require('@prisma/client');
const { OAuth2Client } = require('google-auth-library');
const cors = require("cors");
const app = express();

// Set up CORS options
const corsOptions = {
    origin: "http://localhost:5173", // Allow requests from the frontend port (5173)
    methods: ["GET", "POST", "PUT", "DELETE"], // Allowed HTTP methods
    allowedHeaders: ["Content-Type", "Authorization"], // Allowed headers
    credentials: true, // Allow cookies to be sent with requests (optional)
  };
  
// Enable CORS with the options
app.use(cors(corsOptions));

const prisma = new PrismaClient();

app.use(express.json());

const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// ✅ Google OAuth2 Authorization Endpoint
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Ensures refresh token is received
        scope: [
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
        prompt: 'consent' // Forces re-authentication to get a refresh token
    });

    res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.status(400).json({ error: "Authorization code missing" });

        console.log("Received authorization code:", code);  // Log the code for verification
        
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.refresh_token) {
            return res.status(400).json({ error: "Refresh token not received. Try re-authorizing." });
        }

        // Store tokens in database
        await prisma.googleAuth.upsert({
            where: { id: 1 }, // Assuming single user auth
            update: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: new Date(Date.now() + 3600 * 1000) },
            create: { id: 1, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: new Date(Date.now() + 3600 * 1000) },
        });

        console.log('✅ OAuth callback handled. Tokens saved.');
        res.status(200).json({ message: "Authentication successful!" });
    } catch (error) {
        console.error('❌ Error handling OAuth callback:', error);
        res.status(500).json({ error: "OAuth callback failed", details: error.message });
    }
});

console.log("Redirect URI from .env: ", process.env.GOOGLE_REDIRECT_URI);
console.log("OAuth2Client redirect URI: ", oauth2Client.redirectUri);



// ✅ Get stored tokens
async function getStoredTokens() {
    try {
        const tokenRecord = await prisma.googleAuth.findUnique({ where: { id: 1 } });
        if (!tokenRecord) throw new Error("No stored tokens found. Re-authentication required.");
        return tokenRecord;
    } catch (error) {
        console.error("❌ Error retrieving stored tokens:", error.message);
        throw error;
    }
}

// ✅ Refresh Access Token
async function refreshAccessToken() {
    try {
        const storedTokens = await getStoredTokens();
        oauth2Client.setCredentials({ refresh_token: storedTokens.refreshToken });

        const { credentials } = await oauth2Client.refreshAccessToken();
        if (!credentials.access_token) throw new Error("Failed to retrieve access token");

        await prisma.googleAuth.update({
            where: { id: 1 },
            data: {
                accessToken: credentials.access_token,
                expiresAt: new Date(Date.now() + 3600 * 1000),
            }
        });

        console.log('✅ Access token refreshed successfully!');
        return credentials.access_token;
    } catch (error) {
        console.error('❌ Error refreshing access token:', error.message);
        throw error;
    }
}

// ✅ Create Mail Transporter
async function createTransporter() {
    try {
        let storedTokens = await getStoredTokens();
        let accessToken = storedTokens.accessToken;

        if (!accessToken || new Date() > storedTokens.expiresAt) {
            console.log('⚠️ Access token expired. Refreshing...');
            accessToken = await refreshAccessToken();
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                type: 'OAuth2',
                user: process.env.GMAIL_USER,
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                refreshToken: storedTokens.refreshToken,
                accessToken,
            },
        });

        await transporter.verify();
        console.log('✅ Mail transporter verified successfully.');
        return transporter;
    } catch (error) {
        console.error('❌ Error creating mail transporter:', error);
        throw error;
    }
}

// ✅ Send Email
async function sendReferralEmail(toEmail, referrerName) {
    try {
        const transporter = await createTransporter();

        const mailOptions = {
            from: `Sagar Debnath <${process.env.GMAIL_USER}>`,
            to: toEmail,
            subject: 'You have been referred!',
            text: `Hello,\n\n${referrerName} has referred you. Feel free to reach out!\n\nBest,\nTeam`,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully:', info.messageId);
        return info;
    } catch (error) {
        console.error('❌ Error sending email:', error);
        throw error;
    }
}

// ✅ Test Email Endpoint
app.get('/test-email', async (req, res) => {
    try {
        const testEmail = req.query.email || process.env.GMAIL_USER;
        console.log('Sending test email to:', testEmail);

        const info = await sendReferralEmail(testEmail, 'Test User');

        res.status(200).json({
            status: 'success',
            message: 'Test email sent successfully!',
            details: { messageId: info.messageId, recipient: testEmail },
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Failed to send test email', error: error.message });
    }
});

// ✅ Referral Submission API
app.post('/api/referrals', async (req, res) => {
    try {
      const { name, email, phone, referrer_id, referrer_name, message } = req.body;
  
      if (!name || !email || !phone || !referrer_id || !referrer_name) {
        return res.status(400).json({ error: 'All fields except message are required' });
      }
  
      const referral = await prisma.referral.create({
        data: { name, email, phone, referrer_id, referrer_name, message },
      });
  
      try {
        await sendReferralEmail(email, referrer_name);
      } catch (emailError) {
        console.error('❌ Failed to send email, but referral was created:', emailError);
        return res.status(201).json({
          message: 'Referral submitted successfully, but email notification failed',
          referral,
        });
      }
  
      res.status(201).json({ message: 'Referral submitted successfully', referral });
    } catch (error) {
      console.error('❌ Error creating referral:', error);
      if (error.code === 'P2002') {
        return res.status(400).json({ error: 'Email already exists' });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  

// ✅ Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ✅ Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
