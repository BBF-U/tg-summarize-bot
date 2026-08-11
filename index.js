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

      console.log(
        `Спроба ${i + 1} не вдалась, чекаю ${delay / 1000}с...`
      );

      await new Promise(res => setTimeout(res, delay));
    }
  }
}

function retryKeyboard(command) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Повторити', callback_data: command }]
      ]
    }
  };
}

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption;

  if (!text || text.startsWith('/')) return;

  if (!messageHistory[chatId]) {
    messageHistory[chatId] = [];
  }

  messageHistory[chatId].push(
    `${msg.from.first_name}: ${text}`
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const command = query.data;

  await bot.answerCallbackQuery(query.id);

  bot.emit('text', {
    ...query.message,
    text: `/${command}`,
    chat: { id: chatId },
    from: query.from
  });
});

async function handleCommand(
  chatId,
  command,
  waitMsg,
  successPrefix,
  promptText
) {
  const history = messageHistory[chatId];

  if (!history || history.length === 0) {
    return bot.sendMessage(
      chatId,
      '📭 Немає повідомлень. Перешли щось і спробуй знову.'
    );
  }

  bot.sendMessage(chatId, waitMsg);

  try {
    const text = await generateWithRetry(
      'gemini-3.6-flash',
      promptText
    );

    messageHistory[chatId] = [];

    bot.sendMessage(
      chatId,
      `${successPrefix}\n\n${text}`
    );
  } catch (e) {
    console.error(e);

    bot.sendMessage(
      chatId,
      '❌ Помилка. Спробуй ще раз:',
      retryKeyboard(command)
    );
  }
}

bot.onText(/\/digest/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  const prompt = `Зроби короткий дайджест цих повідомлень. Відповідай українською мовою. Використовуй простий текст БЕЗ markdown, без зірочок, без решіток. Використовуй емодзі для структури. Формат:
🔹 Головні теми — перелічи теми
🔸 Висновки — 2-3 речення

${(history || []).join('\n')}`;

  handleCommand(
    chatId,
    'digest',
    '⏳ Аналізую...',
    '📋 Дайджест:',
    prompt
  );
});

bot.onText(/\/tldr/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  const prompt = `Підсумуй ці повідомлення у 3 коротких речення. Тільки найголовніше. Без зайвих слів. Відповідай українською.

${(history || []).join('\n')}`;

  handleCommand(
    chatId,
    'tldr',
    '⏳ Стискаю до мінімуму...',
    '⚡ TL;DR:',
    prompt
  );
});

bot.onText(/\/topics/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  const prompt = `Виділи список головних тем з цих повідомлень. Кожна тема — один рядок з емодзі. Без пояснень і висновків. Відповідай українською.

${(history || []).join('\n')}`;

  handleCommand(
    chatId,
    'topics',
    '⏳ Виділяю теми...',
    '🗂 Теми:',
    prompt
  );
});

bot.onText(/\/casualties/, async (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  if (!history || history.length === 0) {
    return bot.sendMessage(
      chatId,
      '📭 Немає повідомлень. Перешли щось і спробуй знову.'
    );
  }

  bot.sendMessage(chatId, '⏳ Рахую втрати...');

  try {
    const prompt = `Роль: Ти — аналітик текстових зведень про обстріли.

Твоє завдання — визначити кількість загиблих та поранених цивільних по кожній області України.

АЛГОРИТМ ПІДРАХУНКУ:

1. Спочатку знайди всі добові зведення ОВА/МВА/прокуратури зі словами:
- "за минулу добу"
- "упродовж доби"
- "за добу"
- "протягом доби"
- "минулої доби"

Це головне джерело по кожній області.

2. Для кожної області окремо:

- Якщо є добове зведення ОВА/МВА/прокуратури → використовуй ТІЛЬКИ його остаточні цифри.
- Ігноруй оперативні повідомлення по містах цієї ж області, якщо вони описують події, які вже входять до добового зведення.
- Якщо добового зведення області НЕМАЄ → збирай усі оперативні повідомлення цієї області та додавай їх, але не допускай повторного рахунку однієї події.

3. Якщо одна і та сама подія згадується декілька разів різними джерелами (ОВА, МВА, прокуратура, ДСНС, поліція, мер тощо) — рахуй її лише ОДИН раз.

Якщо є кілька цифр щодо тієї самої події:
- використовуй найновішу / остаточно уточнену цифру;
- попередню цифру НЕ включай у підсумок;
- попередню цифру внеси до "excluded".

4. Київ є окремим регіоном і НЕ входить до Київської області.

5. Дітьми вважай усіх осіб віком ДО 18 років.

6. Кількість дітей НЕ МОЖНА вигадувати.

Якщо в повідомленні прямо вказано кількість дітей — використовуй цю кількість.

Якщо сказано лише "серед постраждалих є дитина/діти", але точна кількість не вказана — НЕ вигадуй число.

Якщо точна кількість дітей невідома, використовуй 0 лише тоді, коли з тексту немає жодних підтверджень про дітей.

7. Не створюй область, якщо:
dead = 0
injured = 0
dead_children = 0
injured_children = 0

8. Один регіон = один запис.

9. Після підрахунку ОБОВ'ЯЗКОВО перевір:

- чи немає однакових областей;
- чи кожна подія врахована лише один раз;
- чи оперативна новина не дублює добове зведення;
- чи не врахована попередня цифра замість остаточної;
- чи сума dead по областях дорівнює загальній кількості загиблих;
- чи сума injured по областях дорівнює загальній кількості поранених;
- чи сума dead_children по областях дорівнює загальній кількості загиблих дітей;
- чи сума injured_children по областях дорівнює загальній кількості поранених дітей;
- чи всі числа є цілими та >= 0.

10. НЕВРАХОВАНІ ПОВІДОМЛЕННЯ:

Якщо повідомлення НЕ включене до підсумку через:
- дублювання вже врахованої події;
- наявність добового зведення, яке має пріоритет;
- попередню цифру, яку пізніше уточнили;
- повторне повідомлення про ту саму подію;

обов'язково додай його до масиву "excluded".

Для кожного неврахованого повідомлення вкажи:

- name — область;
- dead — кількість загиблих у неврахованому повідомленні;
- dead_children — кількість загиблих дітей, якщо відома, інакше 0;
- injured — кількість поранених у неврахованому повідомленні;
- injured_children — кількість поранених дітей, якщо відома, інакше 0;
- reason — коротка причина, чому повідомлення не враховано.

Дані з "excluded" НЕ входять до підсумку "regions".

Не додавай одне й те саме повідомлення до "excluded" більше одного разу.

11. ОСОБЛИВО ВАЖЛИВО:

Якщо оперативне повідомлення містить більшу кількість постраждалих, ніж добове зведення, НЕ можна автоматично додавати різницю.

Спочатку визнач, чи це:
- та сама подія;
- пізніше уточнення;
- інша подія.

Якщо це та сама подія — використовуй остаточну цифру.

Якщо це інша подія, яка сталася поза періодом добового зведення, її потрібно врахувати окремо.

12. Якщо повідомлення містить конкретні віки постраждалих, використовуй їх для визначення дітей.

13. Якщо повідомлення містить лише загальну кількість постраждалих без розподілу за віком — не вигадуй кількість дітей.

ПОВЕРНИ ТІЛЬКИ ВАЛІДНИЙ JSON.

Структура:

{
  "regions": [
    {
      "name": "Київ",
      "dead": 9,
      "dead_children": 0,
      "injured": 33,
      "injured_children": 4
    }
  ],
  "excluded": [
    {
      "name": "Київська",
      "dead": 1,
      "dead_children": 0,
      "injured": 3,
      "injured_children": 0,
      "reason": "Оперативне повідомлення, подія вже входить до добового зведення"
    }
  ]
}

Якщо неврахованих повідомлень немає:

{
  "regions": [...],
  "excluded": []
}

Не додавай жодного тексту поза JSON.

${history.join('\n')}`;

    const raw = await generateWithRetry(
      "gemini-2.5-flash",
      prompt
    );

    const clean = raw
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const parsed = JSON.parse(clean);

    if (!parsed.regions || !Array.isArray(parsed.regions)) {
      throw new Error("JSON не містить regions");
    }

    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded
      : [];

    // Об'єднання однакових областей
    const map = new Map();

    for (const r of parsed.regions) {
      const name = String(r.name || '').trim();

      if (!name) continue;

      const dead = Number.isInteger(Number(r.dead))
        ? Number(r.dead)
        : 0;

      const deadChildren = Number.isInteger(Number(r.dead_children))
        ? Number(r.dead_children)
        : 0;

      const injured = Number.isInteger(Number(r.injured))
        ? Number(r.injured)
        : 0;

      const injuredChildren = Number.isInteger(Number(r.injured_children))
        ? Number(r.injured_children)
        : 0;

      if (!map.has(name)) {
        map.set(name, {
          name,
          dead,
          dead_children: deadChildren,
          injured,
          injured_children: injuredChildren
        });
      } else {
        const x = map.get(name);

        x.dead += dead;
        x.dead_children += deadChildren;
        x.injured += injured;
        x.injured_children += injuredChildren;
      }
    }

    const regions = [...map.values()]
      .filter(r =>
        r.dead > 0 ||
        r.injured > 0 ||
        r.dead_children > 0 ||
        r.injured_children > 0
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, "uk")
      );

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

      if (d10 === 1 && d100 !== 11) {
        return one;
      }

      if (
        d10 >= 2 &&
        d10 <= 4 &&
        (d100 < 12 || d100 > 14)
      ) {
        return few;
      }

      return many;
    }

    const osoby = n =>
      plural(n, "особа", "особи", "осіб");

    const dytyny = n =>
      plural(n, "дитина", "дитини", "дітей");

    const zahynulo = n =>
      n === 1 ? "загинула" : "загинуло";

    function cleanRegionName(name) {
      return String(name)
        .replace(/\s+область$/i, "")
        .replace(/\s+обл\.?$/i, "")
        .trim();
    }

    const regionNames = regions
      .map(r => cleanRegionName(r.name))
      .join(", ");

    const regionList = regions
      .map(r => {
        const name = cleanRegionName(r.name);

        return `${name} — ${r.dead}/${r.injured}`;
      })
      .join("\n");

    const excludedList = excluded.length
      ? excluded
          .map(r => {
            const name = cleanRegionName(r.name);

            const dead = Number(r.dead) || 0;
            const deadChildren =
              Number(r.dead_children) || 0;

            const injured = Number(r.injured) || 0;
            const injuredChildren =
              Number(r.injured_children) || 0;

            return `• ${name} — ${dead}/${injured} (діти: ${deadChildren}/${injuredChildren}) — ${r.reason || 'Причина не вказана'}`;
          })
          .join("\n")
      : "Немає";

    const msg =
`⚔️ Втрати серед цивільних: Загалом ${zahynulo(totalDead)} ${totalDead} ${osoby(totalDead)}, з них ${totalDeadChildren} ${dytyny(totalDeadChildren)}. Поранення отримали ${totalInjured} ${osoby(totalInjured)}, з них ${totalInjuredChildren} ${dytyny(totalInjuredChildren)}, внаслідок ворожих атак у ${regions.length} ${plural(regions.length, "області", "областях", "областях")} (${regionNames}).

По областях (загиблі/поранені):
${regionList}

Не враховано:
${excludedList}`;

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
