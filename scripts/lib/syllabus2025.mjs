// Parser for the vocabulary syllabus (词汇大纲) of the official 2025 HSK exam syllabus
// 《中文水平考试 HSK考试大纲》 (CLEC, "2025-11 发布 2026-07 实施"), from `pdftotext -layout` output.
// Rows look like "  7   1（4）   半    bàn    数、（副）": 序号 (1-11000), 等级 (level; levels of a further sense
// in parentheses), 词语 (a trailing digit numbers a homograph sense: 本1, 点1), 拼音 (as printed: with the
// tone changes of 一 and 不, phrases as separate words) and 词性 (may be empty). Nothing is guessed:
// rows that do not parse are returned as problems.

export function parseSyllabusText(text) {
  const LEVEL = /^(\d|7-9|7—9|七—九)((?:（[\d、—-]+）)*)$/;
  const POS_TAIL = /^(.*?)\s{2,}([\u4e00-\u9fff（）][\u4e00-\u9fff（）、 ]*)$/; // POS may contain a space after 、 (row 6716)
  const rows = [];
  const problems = [];
  let inVocab = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\f/g, '').replace(/\s+$/, '');
    if (/序号\s+等级\s+词语\s+拼音\s+词性/.test(line)) {
      inVocab = true;
      continue;
    }
    if (!inVocab) continue;
    const m = /^\s*(\d{1,5})\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, seqText, levelText, wordText, rest] = m;
    const seq = Number(seqText);
    if (seq < 1 || seq > 11000) continue;
    const lv = LEVEL.exec(levelText.replace('七—九', '7-9').replace('7—9', '7-9'));
    if (!lv) {
      problems.push({ seq, line, why: 'level' });
      continue;
    }
    let pinyin = rest.trim();
    let pos = '';
    const tail = POS_TAIL.exec(pinyin);
    if (tail) {
      pinyin = tail[1].trim();
      pos = tail[2].replace(/\s+/g, '');
    } else if (/[一-鿿]/.test(pinyin)) {
      // single space between pinyin and POS
      const t2 = /^(.*?[a-zA-ZāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüÀ-ɏ'’])\s+([一-鿿（）、]+)$/.exec(pinyin);
      if (t2) {
        pinyin = t2[1].trim();
        pos = t2[2];
      } else {
        problems.push({ seq, line, why: 'pinyin/pos split' });
        continue;
      }
    }
    const sense = /^(.*?)(\d)$/.exec(wordText);
    const extra = [...lv[2].matchAll(/（([^）]+)）/g)].flatMap((x) => x[1].split('、'));
    rows.push({
      seq,
      level: lv[1] === '七—九' || lv[1] === '7—9' ? '7-9' : lv[1],
      extra_levels: extra,
      word_as_printed: wordText,
      word: sense ? sense[1] : wordText,
      sense: sense ? Number(sense[2]) : null,
      pinyin_as_printed: pinyin,
      pos_as_printed: pos,
      pos: pos ? pos.split('、').map((p) => p.trim()).filter(Boolean) : [],
    });
  }

  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.seq)) problems.push({ seq: r.seq, why: 'duplicate number', line: `${seen.get(r.seq).word_as_printed} / ${r.word_as_printed}` });
    seen.set(r.seq, r);
  }
  for (let i = 1; i <= 11000; i += 1) if (!seen.has(i)) problems.push({ seq: i, why: 'missing number' });
  return { rows: rows.sort((a, b) => a.seq - b.seq), problems };
}
