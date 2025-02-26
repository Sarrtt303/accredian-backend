const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const TOKEN_FILE = './refresh_token.json';

// Load refresh token from file
function loadRefreshToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const data = fs.readFileSync(TOKEN_FILE, 'utf8');
            return JSON.parse(data).refresh_token || process.env.GOOGLE_REFRESH_TOKEN;
        }
    } catch (error) {
        console.error('Error loading refresh token:', error);
    }
    return process.env.GOOGLE_REFRESH_TOKEN;
}

// Save new refresh token to file
function saveRefreshToken(refresh_token) {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token }), 'utf8');
        console.log('New refresh token saved!');
    } catch (error) {
        console.error('Error saving refresh token:', error);
    }
}

module.exports = { loadRefreshToken, saveRefreshToken };
