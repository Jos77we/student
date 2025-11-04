import dotenv from 'dotenv';
dotenv.config();

const {
  TELEGRAM_TOKEN,
  MONGO_URI,
  OPENROUTER_KEY,
  PORT = 3000,
  NODE_ENV = 'development',
  WEBHOOK_URL = ''
} = process.env;

console.log(TELEGRAM_TOKEN)
if (!TELEGRAM_TOKEN) {
  console.warn('Warning: TELEGRAM_TOKEN is not set. Bot will not work until provided.');
}
if (!MONGO_URI) {
  console.warn('Warning: MONGO_URI is not set. DB connection will fail without it.');
}

export const config = {
  TELEGRAM_TOKEN,
  MONGO_URI,
  OPENROUTER_KEY,
  PORT: Number(PORT),
  NODE_ENV,
  WEBHOOK_URL
};
