const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const messageHistory = {};

async function generateWithRetry(modelName, prompt, retries = 3) {
  const model = genAI.getGenerativeModel({ model: modelName });
  for (let i = 0; i < retries; i++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      if (i === retries - 1) throw e;
      const delay = (i + 1) * 3000;
      console.log(`Спроба ${i + 1} не вдалась, чекаю ${delay / 1000}с...`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

function retryKeyboard(command) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '🔄 Повторити', callback_data: command }]]
    }
  };
}

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption;
  if (!text || text.startsWith('/')) return;
  if (!messageHistory[chatId]) messageHistory[chatId] = [];
  messageHistory[chatId].push(`${msg.from.first_name}: ${text}`);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const command = query.data;
  await bot.answerCallbackQuery(query.id);
  bot.emit('text', { ...query.message, text: `/${command}`, chat: { id: chatId }, from: query.from });
});

async function handleCommand(chatId, command, waitMsg, successPrefix, promptText) {
  const history = messageHistory[chatId];
  if (!history || history.length === 0) {
    return bot.sendMessage(chatId, '📭 Немає повідомлень. Перешли щось і спробуй знову.');
  }
  bot.sendMessage(chatId, waitMsg);
  try {
    const text = await generateWithRetry('gemini-2.5-flash', promptText);
    messageHistory[chatId] = [];
    bot.sendMessage(chatId, `${successPrefix}\n\n${text}`);
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Помилка. Спробуй ще раз:', retryKeyboard(command));
  }
}

bot.onText(/\/digest/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];
  const prompt = `Зроби короткий дайджест цих повідомлень. Відповідай українською мовою. Використовуй простий текст БЕЗ markdown, без зірочок, без решіток. Використовуй емодзі для структури. Формат:\n🔹 Головні теми — перелічи теми\n🔸 Висновки — 2-3 речення\n\n${(history || []).join('\n')}`;
  handleCommand(chatId, 'digest', '⏳ Аналізую...', '📋 Дайджест:', prompt);
});

bot.onText(/\/tldr/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];
  const prompt = `Підсумуй ці повідомлення у 3 коротких речення. Тільки найголовніше. Без зайвих слів. Відповідай українською.\n\n${(history || []).join('\n')}`;
  handleCommand(chatId, 'tldr', '⏳ Стискаю до мінімуму...', '⚡ TL;DR:', prompt);
});

bot.onText(/\/topics/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];
  const prompt = `Виділи список головних тем з цих повідомлень. Кожна тема — один рядок з емодзі. Без пояснень і висновків. Відповідай українською.\n\n${(history || []).join('\n')}`;
  handleCommand(chatId, 'topics', '⏳ Виділяю теми...', '🗂 Теми:', prompt);
});

bot.onText(/\/casualties/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];
  const prompt = `Проаналізуй ці повідомлення і підрахуй загальну кількість загиблих та поранених серед цивільного населення. Відповідай українською. Напиши одне речення у форматі:\n\nЗагалом загинуло X осіб та Y осіб отримали поранення внаслідок ворожих атак у [перелік областей].\n\nЯкщо точна цифра невідома — пиши "щонайменше X". Якщо даних немає — пиши "дані відсутні". Без додаткових пояснень.\n\n${(history || []).join('\n')}`;
  handleCommand(chatId, 'casualties', '⏳ Рахую втрати...', '⚔️ Втрати серед цивільних:', prompt);
});

console.log('Bot started!');
