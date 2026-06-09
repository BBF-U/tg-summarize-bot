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
  const prompt = `Роль: Ти — аналітик текстових новин та зведень про обстріли. Твоє завдання — точно підраховувати кількість загиблих та поранених (постраждалих) людей на основі наданого тексту.

Критично важливе правило (Уникнення подвійного підрахунку): Тексти можуть містити як окремі оперативні новини щодо конкретних міст (наприклад, Харків, Чугуїв), так і загальні добові зведення від голів ОВА по всій області. Міста та громади є частиною цих областей.

Перед тим як додавати цифри, виконай такий алгоритм:

1. Групування за регіонами: Розподіли всі згадані дані про постраждалих за областями.
2. Аналіз вкладеності: Якщо в межах однієї області є окрема новина про місто і загальне добове зведення по цій же області — НЕ ДОДАВАЙ їх одне до одного. Використовуй більшу підсумкову цифру з добового зведення ОВА. Якщо локальні дані більші або не збігаються з добовими — чітко вкажи це у примітці.
3. Логічна перевірка: Якщо текст містить дублікати або перепости тієї самої новини з різних джерел — рахуй цих постраждалих лише ОДИН РАЗ.

Формат відповіді:
- Список за областями з логікою підрахунку
- Що було враховано, а що ні
- Наприкінці: "⚔️ Загальний підсумок: загинуло X осіб, поранено Y осіб у [перелік областей]."

Відповідай українською.\n\n${(history || []).join('\n')}`;
  handleCommand(chatId, 'casualties', '⏳ Рахую втрати...', '⚔️ Втрати серед цивільних:', prompt);
});

console.log('Bot started!');
