const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const messageHistory = {};

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption;
  if (!text || text.startsWith('/')) return;

  if (!messageHistory[chatId]) messageHistory[chatId] = [];
  messageHistory[chatId].push(`${msg.from.first_name}: ${text}`);
});

bot.onText(/\/digest/, async (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  if (!history || history.length === 0) {
    return bot.sendMessage(chatId, '📭 Немає повідомлень для підсумування. Перешли повідомлення і спробуй знову.');
  }

  bot.sendMessage(chatId, '⏳ Аналізую...');

  // Одразу скидаємо історію для наступного разу
  messageHistory[chatId] = [];

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `Зроби короткий дайджест цих повідомлень. Відповідай українською мовою. Використовуй простий текст БЕЗ markdown, без зірочок, без решіток. Використовуй емодзі для структури. Формат:\n🔹 Головні теми — перелічи теми\n🔸 Висновки — 2-3 речення\n\n${history.join('\n')}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    bot.sendMessage(chatId, `📋 Дайджест:\n\n${text}`);
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Помилка при генерації дайджесту.');
  }
});

console.log('Bot started!');
