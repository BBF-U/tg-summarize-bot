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
    const text = await generateWithRetry('gemini-3.6-flash', promptText);
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

bot.onText(/\/casualties/, async (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];
  if (!history || history.length === 0) {
    return bot.sendMessage(chatId, '📭 Немає повідомлень. Перешли щось і спробуй знову.');
  }
  bot.sendMessage(chatId, '⏳ Рахую втрати...');
  try {
    const prompt = `Роль: Ти — аналітик текстових зведень про обстріли. Твоє завдання — вирахувати точну загальну кількість загиблих та поранених цивільних.

Алгоритм підрахунку:

1. Спочатку знайди всі добові зведення ОВА (повідомлення від начальників ОВА/прокуратури зі словами "за минулу добу", "упродовж доби", "за добу", "протягом доби"). Це головне джерело по кожній області.

2. Для кожної області окремо:
   - Якщо є добове зведення ОВА → використовуй ТІЛЬКИ його цифри, ігноруй оперативні новини по містах цієї ж області.
   - Якщо добового зведення ОВА НЕМАЄ → збирай усі оперативні новини по цій області/місту і додавай їх.

3. Не пропускай жодної області чи міста де є постраждалі — Київ, Харків, Одеса, Чернігів, Київська область тощо теж рахуються.

4. Якщо одна і та сама подія згадується двічі з різних джерел (наприклад, мер міста і ОВА про один прильот) — рахуй ОДИН раз, беручи більшу цифру.

5. Збери назви всіх областей/міст де є постраждалі.

6. Дітьми вважати осіб до 18 років.

Поверни ТІЛЬКИ валідний JSON без жодного тексту, пояснень чи markdown:
{"regions":[{"name":"Назва регіону","dead":0,"dead_children":0,"injured":0,"injured_children":0}]}

${history.join('\n')}`;

    const raw = await generateWithRetry('gemini-2.5-flash', prompt);
    const clean = raw.replace(/```json|```/g, '').trim();
    const { regions } = JSON.parse(clean);

    const totalDead = regions.reduce((s, r) => s + r.dead, 0);
    const totalDeadChildren = regions.reduce((s, r) => s + r.dead_children, 0);
    const totalInjured = regions.reduce((s, r) => s + r.injured, 0);
    const totalInjuredChildren = regions.reduce((s, r) => s + r.injured_children, 0);
    const regionNames = regions.map(r => r.name).join(', ');
    const regionList = regions.map(r => `${r.name} — ${r.dead}/${r.injured}`).join('\n');

    function osoby(n) {
      if (n === 1) return 'особа';
      if (n >= 2 && n <= 4) return 'особи';
      return 'осіб';
    }

    function dytyny(n) {
      if (n === 1) return 'дитина';
      if (n >= 2 && n <= 4) return 'дитини';
      return 'дітей';
    }

    function zahynuly(n) {
      if (n === 1) return 'загинула';
      return 'загинуло';
    }

    const msg1 = `⚔️ Втрати серед цивільних: Загалом ${zahynuly(totalDead)} ${totalDead} ${osoby(totalDead)}, з них ${totalDeadChildren} ${dytyny(totalDeadChildren)}. Поранення отримали ${totalInjured} ${osoby(totalInjured)}, з них ${totalInjuredChildren} ${dytyny(totalInjuredChildren)}, внаслідок ворожих атак у ${regionNames}.\n\nПо областях (загиблі/поранені):\n${regionList}`;

    messageHistory[chatId] = [];
    bot.sendMessage(chatId, msg1);
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Помилка. Спробуй ще раз:', retryKeyboard('casualties'));
  }
});

Тепер Gemini тільки класифікує дані по регіонах, а JavaScript сам рахує суми — жодних математичних помилок! 👍

console.log('Bot started!');
