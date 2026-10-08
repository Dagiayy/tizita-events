'use client';
import { useEffect, useRef, useState } from 'react';
import { ET_MONTHS_AM, ET_MONTHS_EN, daysInEthiopianMonth, eatParts, ethiopianToGregorian, fromEat, gregorianToEthiopian } from '@/lib/ethiopian';
import { useI18n } from '@/lib/i18n';

const pad = (n: number) => String(n).padStart(2, '0');
const gregValue = (d: Date) => { const p = eatParts(d); return `${String(p.y).padStart(4, '0')}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`; };

/**
 * Date/time entry in Gregorian or Ethiopian calendar. Always yields an absolute instant (EAT wall-clock -> UTC).
 * The inputs keep their own draft text while the person types and only emit a complete, valid date; the draft is
 * re-synced from `value` only when the parent changes it (otherwise typing a year digit by digit gets overwritten).
 */
export function DateTimeEntry({ label, value, onChange }: { label: string; value: Date; onChange: (d: Date) => void }) {
  const { t, lang } = useI18n();
  const [cal, setCal] = useState<'g' | 'e'>('g');
  const lastEmitted = useRef<number>(value.getTime());

  const p = eatParts(value); const e = gregorianToEthiopian(p.y, p.m, p.d);
  const [gDraft, setGDraft] = useState(gregValue(value));
  const [ey, setEy] = useState(String(e.year)); const [em, setEm] = useState(e.month); const [ed, setEd] = useState(e.day);
  const [time, setTime] = useState(`${pad(p.hh)}:${pad(p.mm)}`);

  useEffect(() => {
    if (value.getTime() === lastEmitted.current) return; // our own change coming back
    const q = eatParts(value); const x = gregorianToEthiopian(q.y, q.m, q.d);
    setGDraft(gregValue(value)); setEy(String(x.year)); setEm(x.month); setEd(x.day); setTime(`${pad(q.hh)}:${pad(q.mm)}`);
    lastEmitted.current = value.getTime();
  }, [value]);

  const push = (d: Date) => { if (Number.isNaN(d.getTime())) return; lastEmitted.current = d.getTime(); onChange(d); };

  const emitEthiopian = (yStr: string, m: number, d: number, tm: string) => {
    const y = Number(yStr);
    if (!/^\d{4}$/.test(yStr) || y < 1900 || y > 2300) return; // wait until a plausible 4-digit year is typed
    const [hh, mm] = tm.split(':').map(Number);
    const g = ethiopianToGregorian(y, m, Math.min(d, daysInEthiopianMonth(y, m)));
    push(fromEat(g.year, g.month, g.day, hh || 0, mm || 0));
  };

  const monthDays = daysInEthiopianMonth(Number(ey) || e.year, em);
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 600, marginBottom: 4 }}>{label}</legend>
      <div className="row" style={{ marginBottom: 6 }}>
        <label className="check"><input type="radio" checked={cal === 'g'} onChange={() => setCal('g')} /><span className="small">{t('common.gregorian')}</span></label>
        <label className="check"><input type="radio" checked={cal === 'e'} onChange={() => setCal('e')} /><span className="small">{t('common.ethiopian')}</span></label>
      </div>
      {cal === 'g' ? (
        <input
          type="datetime-local" min="1900-01-01T00:00" max="2300-12-31T23:59" value={gDraft}
          onChange={(ev) => {
            setGDraft(ev.target.value);
            const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ev.target.value);
            if (m && +m[1] >= 1900 && +m[1] <= 2300) push(fromEat(+m[1], +m[2], +m[3], +m[4], +m[5]));
          }}
        />
      ) : (
        <div className="row">
          <select aria-label="day" value={Math.min(ed, monthDays)} onChange={(x) => { setEd(+x.target.value); emitEthiopian(ey, em, +x.target.value, time); }} style={{ width: 80 }}>{Array.from({ length: monthDays }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select>
          <select aria-label="month" value={em} onChange={(x) => { setEm(+x.target.value); emitEthiopian(ey, +x.target.value, ed, time); }} style={{ flex: 1 }}>{(lang === 'am' ? ET_MONTHS_AM : ET_MONTHS_EN).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
          <input aria-label="year" type="text" inputMode="numeric" maxLength={4} value={ey} onChange={(x) => { const v = x.target.value.replace(/\D/g, ''); setEy(v); emitEthiopian(v, em, ed, time); }} style={{ width: 100 }} />
          <input aria-label="time" type="time" value={time} onChange={(x) => { setTime(x.target.value); if (x.target.value) emitEthiopian(ey, em, ed, x.target.value); }} style={{ width: 120 }} />
        </div>
      )}
    </fieldset>
  );
}
