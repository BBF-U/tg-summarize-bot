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

Твоє завдання — визначити точну кількість загиблих та поранених цивільних по кожній області України.

АЛГОРИТМ ПІДРАХУНКУ:

1. Знайди всі повідомлення про загиблих і поранених цивільних.

2. Для кожної області визнач:
- які повідомлення описують окремі події;
- які повідомлення є повтором тієї самої події;
- які повідомлення є уточненням уже опублікованої інформації;
- які повідомлення входять до добового зведення.

3. ДОБОВІ ЗВЕДЕННЯ:

Знайди повідомлення ОВА/МВА/прокуратури зі словами:
- "за минулу добу"
- "упродовж доби"
- "за добу"
- "протягом доби"
- "минулої доби"

Такі зведення мають високий пріоритет, але НЕ означають автоматично, що всі інші повідомлення цієї області треба відкинути.

Добове зведення є основним підсумком лише за той період, який воно описує.

4. НЕ ВВАЖАЙ АВТОМАТИЧНО ПІЗНІШЕ ПОВІДОМЛЕННЯ ДУБЛЕМ.

Якщо після добового зведення з'явилося оперативне повідомлення, визнач, чи це:

A) та сама подія, яка вже врахована;
B) уточнення кількості постраждалих у тій самій події;
C) нова окрема подія.

Якщо це A або B — не додавай людей повторно.

Якщо це C — ОБОВ'ЯЗКОВО додай нових загиблих та поранених до підсумку.

Не відкидай оперативну новину лише тому, що для цієї області вже є добове зведення.

5. КОЛИ ВВАЖАТИ ПОВІДОМЛЕННЯ УТОЧНЕННЯМ:

Вважай нове повідомлення уточненням попереднього лише тоді, коли з тексту прямо або однозначно випливає, що це та сама подія.

Наприклад:
- "уточнено кількість постраждалих";
- "раніше повідомлялося про 5, тепер відомо про 8";
- "кількість поранених зросла до...";
- описано те саме місце, той самий удар і ту саму подію, але пізніше стало відомо про нову кількість постраждалих.

Якщо такого зв'язку немає — НЕ вигадуй, що це уточнення.

6. НЕ МОЖНА ВВАЖАТИ ДУБЛЕМ ЛИШЕ ЧЕРЕЗ:
- однакову область;
- однакове місто;
- однаковий день;
- однаковий тип зброї;
- однакове слово "постраждали";
- наявність добового зведення.

Одна область може мати кілька різних подій за один день. Їх потрібно рахувати окремо.

7. Якщо одна і та сама подія згадується декілька разів різними джерелами (ОВА, МВА, прокуратура, ДСНС, поліція, мер тощо) — рахуй її лише ОДИН раз.

Якщо цифри щодо тієї самої події відрізняються — використовуй найновішу підтверджену цифру.

Попередню цифру внеси до "excluded".

8. НЕ ВИКОРИСТОВУЙ ПРАВИЛО "БРАТИ БІЛЬШУ ЦИФРУ".

Більша цифра може стосуватися іншої події.

Спочатку визнач, чи це та сама подія.

Якщо це та сама подія — використовуй остаточну цифру.

Якщо це інша подія — додавай її окремо.

9. Київ є окремим регіоном і НЕ входить до Київської області.

10. Дітьми вважай усіх осіб віком ДО 18 років.

11. Кількість дітей НЕ МОЖНА ВИГАДУВАТИ.

Якщо прямо вказано конкретний вік — визначай дитину за віком.

Якщо прямо вказано "3 дітей" — записуй 3.

Якщо сказано "серед постраждалих є дитина" — це означає щонайменше 1 дитину.

Якщо точна кількість дітей не вказана — НЕ вигадуй точну кількість.

12. Не створюй область, якщо:
dead = 0
injured = 0
dead_children = 0
injured_children = 0

13. Один регіон = один запис.

14. Після підрахунку ОБОВ'ЯЗКОВО перевір:

- чи немає однакових областей;
- чи кожна окрема подія врахована лише один раз;
- чи не відкинута нова подія через наявність добового зведення;
- чи попередні цифри не були додані разом з остаточними;
- чи сума dead по областях дорівнює загальній кількості загиблих;
- чи сума injured по областях дорівнює загальній кількості поранених;
- чи сума dead_children по областях дорівнює загальній кількості загиблих дітей;
- чи сума injured_children по областях дорівнює загальній кількості поранених дітей;
- чи всі числа є цілими;
- чи всі числа >= 0.

15. НЕВРАХОВАНІ ПОВІДОМЛЕННЯ:

Якщо повідомлення НЕ включене до підсумку через:
- дублювання вже врахованої події;
- уточнення вже врахованої події;
- попередню цифру, яку замінила остаточна;
- іншу чітко визначену причину;

додай його до масиву "excluded".

Для кожного такого повідомлення вкажи:

- name — область;
- dead — кількість загиблих;
- dead_children — кількість загиблих дітей, якщо відома;
- injured — кількість поранених;
- injured_children — кількість поранених дітей, якщо відома;
- reason — коротка конкретна причина.

Дані з "excluded" НЕ входять до підсумку "regions".

Не додавай одне й те саме повідомлення до "excluded" більше одного разу.

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
      "reason": "Повтор тієї самої події, остаточна цифра вже врахована"
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

    const map = new Map();

    for (const r of parsed.regions) {
      const name = String(r.name || '').trim();

      if (!name) continue;

      const dead = Number(r.dead) || 0;
      const deadChildren = Number(r.dead_children) || 0;
      const injured = Number(r.injured) || 0;
      const injuredChildren = Number(r.injured_children) || 0;

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
