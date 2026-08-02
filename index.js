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
    try {
  const prompt = `Роль: Ти — аналітик текстових зведень про обстріли.

Твоє завдання — визначити кількість загиблих та поранених цивільних по кожній області України.

Алгоритм:

1. Знайди всі добові зведення ОВА/МВА/прокуратури зі словами:
- "за добу"
- "упродовж доби"
- "протягом доби"
- "за минулу добу"
- "минулої доби"

2. Для кожної області:

- Якщо є добове зведення → використовуй ТІЛЬКИ його цифри.
- Якщо добового зведення немає → підсумуй усі оперативні повідомлення цієї області.

3. Якщо одна подія згадується декілька разів різними джерелами (ОВА, мер, прокуратура, ДСНС тощо) — врахуй її лише один раз.

4. Київ є окремим регіоном і НЕ входить до Київської області.

5. Дітьми вважай усіх осіб віком до 18 років включно.

6. Не створюй область, якщо:
dead = 0
injured = 0
dead_children = 0
injured_children = 0

7. Один регіон = один запис.

8. Перед поверненням JSON перевір:
- чи немає однакових областей;
- чи всі числа цілі;
- чи всі числа >= 0.

Поверни ТІЛЬКИ валідний JSON.

Структура:

{
  "regions":[
    {
      "name":"Київ",
      "dead":9,
      "dead_children":0,
      "injured":33,
      "injured_children":4
    }
  ]
}

Не додавай жодного тексту.

${history.join('\n')}`;

  const raw = await generateWithRetry("gemini-2.5-flash", prompt);

  const clean = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  const parsed = JSON.parse(clean);

  if (!parsed.regions || !Array.isArray(parsed.regions)) {
    throw new Error("JSON не містить regions");
  }

  // Об'єднання однакових областей (про всяк випадок)
  const map = new Map();

  for (const r of parsed.regions) {

    if (!map.has(r.name)) {

      map.set(r.name, {
        name: r.name,
        dead: Number(r.dead) || 0,
        dead_children: Number(r.dead_children) || 0,
        injured: Number(r.injured) || 0,
        injured_children: Number(r.injured_children) || 0
      });

    } else {

      const x = map.get(r.name);

      x.dead += Number(r.dead) || 0;
      x.dead_children += Number(r.dead_children) || 0;
      x.injured += Number(r.injured) || 0;
      x.injured_children += Number(r.injured_children) || 0;

    }
  }

  const regions = [...map.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));

  const totalDead =
    regions.reduce((s, r) => s + r.dead, 0);

  const totalDeadChildren =
    regions.reduce((s, r) => s + r.dead_children, 0);

  const totalInjured =
    regions.reduce((s, r) => s + r.injured, 0);

  const totalInjuredChildren =
    regions.reduce((s, r) => s + r.injured_children, 0);

  function plural(n, one, few, many) {

    const d10 = n % 10;
    const d100 = n % 100;

    if (d10 === 1 && d100 !== 11)
      return one;

    if (
      d10 >= 2 &&
      d10 <= 4 &&
      (d100 < 12 || d100 > 14)
    )
      return few;

    return many;
  }

  const osoby = n =>
    plural(n, "особа", "особи", "осіб");

  const dytyny = n =>
    plural(n, "дитина", "дитини", "дітей");

  const zahynulo = n =>
    n === 1 ? "загинула" : "загинуло";

  const regionNames =
    regions.map(r => r.name).join(", ");

  const regionList =
    regions
      .map(
        r =>
          `${r.name} — ${r.dead}/${r.injured}`
      )
      .join("\n");

  const msg =
`⚔️ Втрати серед цивільних: Загалом ${zahynulo(totalDead)} ${totalDead} ${osoby(totalDead)}, з них ${totalDeadChildren} ${dytyny(totalDeadChildren)}. Поранення отримали ${totalInjured} ${osoby(totalInjured)}, з них ${totalInjuredChildren} ${dytyny(totalInjuredChildren)}, внаслідок ворожих атак у ${regions.length} ${plural(regions.length, "області", "областях", "областях")} (${regionNames}).

По областях (загиблі/поранені):
${regionList}`;

  messageHistory[chatId] = [];

  bot.sendMessage(chatId, msg);

} catch (err) {

  console.error(err);

  bot.sendMessage(
    chatId,
    "❌ Помилка під час аналізу. Спробуйте ще раз.",
    retryKeyboard("casualties")
  );

}
});

console.log('Bot started!');
