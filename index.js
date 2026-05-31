const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const messageHistory = {};
const MAX_MESSAGES = 50;

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith('/')) return;

  if (!messageHistory[chatId]) messageHistory[chatId] = [];
  messageHistory[chatId].push(`${msg.from.first_name}: ${msg.text}`);

  if (messageHistory[chatId].length > MAX_MESSAGES) {
    messageHistory[chatId].shift();
  }
});

bot.onText(/\/summarize/, async (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  if (!history || history.length === 0) {
    return bot.sendMessage(chatId, '📭 Немає повідомлень для підсумування.');
  }

  bot.sendMessage(chatId, '⏳ Аналізую розмову...');

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = `Зроби короткий дайджест цієї розмови у Telegram-групі. Вкажи головні теми та висновки. Відповідай українською.\n\n${history.join('\n')}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    bot.sendMessage(chatId, `📋 *Підсумок розмови:*\n\n${text}`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Помилка при генерації підсумку.');
  }
});

console.log('Bot started!');
