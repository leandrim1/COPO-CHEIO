// Validação de tudo que chega do navegador. Só colunas declaradas aqui entram no banco;
// o resto do corpo da requisição é ignorado. Os limites espelham os checks das tabelas.
import { HttpError } from './http.js';
import type { Row } from './db.js';

export type Field = {
  label: string;
  required: boolean;
  cast?: string;
  parse: (value: unknown) => unknown;
};
export type Spec = Record<string, Field>;

const bad = (label: string, why: string) => new HttpError(400, `${label}: ${why}`);
const chars = (s: string) => Array.from(s).length;

type TextOpts = { min?: number; max: number; nullable?: boolean; required?: boolean };

export function text(label: string, o: TextOpts): Field {
  return {
    label,
    required: o.required ?? false,
    parse(value) {
      if (value === null || value === undefined) {
        if (o.nullable) return null;
        throw bad(label, 'preencha este campo.');
      }
      if (typeof value !== 'string') throw bad(label, 'texto inválido.');
      const s = value.replace(/\u0000/g, '').trim();
      if (s === '') {
        if (o.nullable) return null;
        if ((o.min ?? 0) > 0) throw bad(label, 'preencha este campo.');
        return '';
      }
      if (o.min && chars(s) < o.min) throw bad(label, `use pelo menos ${o.min} caracteres.`);
      if (chars(s) > o.max) throw bad(label, `use no máximo ${o.max} caracteres.`);
      return s;
    },
  };
}

export function money(label: string, o: { nullable?: boolean; required?: boolean } = {}): Field {
  return {
    label,
    required: o.required ?? false,
    parse(value) {
      if ((value === null || value === undefined || value === '') && o.nullable) return null;
      const n = typeof value === 'string' ? Number(value.includes(',') ? value.replace(/\./g, '').replace(',', '.') : value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(label, 'valor inválido.');
      if (n < 0) throw bad(label, 'não pode ser negativo.');
      if (n > 1_000_000) throw bad(label, 'valor alto demais.');
      return Math.round(n * 100) / 100;
    },
  };
}

export function int(label: string, o: { min?: number; max?: number; nullable?: boolean; required?: boolean } = {}): Field {
  const min = o.min ?? 0;
  const max = o.max ?? 1_000_000;
  return {
    label,
    required: o.required ?? false,
    parse(value) {
      if ((value === null || value === undefined || value === '') && o.nullable) return null;
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw bad(label, 'informe um número inteiro.');
      if (n < min || n > max) throw bad(label, `use um valor entre ${min} e ${max}.`);
      return n;
    },
  };
}

export function bool(label: string, o: { required?: boolean } = {}): Field {
  return {
    label,
    required: o.required ?? false,
    parse(value) {
      if (typeof value !== 'boolean') throw bad(label, 'valor inválido.');
      return value;
    },
  };
}

export function uuid(label: string, o: { nullable?: boolean; required?: boolean } = {}): Field {
  return {
    label,
    required: o.required ?? false,
    parse(value) {
      if ((value === null || value === undefined || value === '') && o.nullable) return null;
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw bad(label, 'valor inválido.');
      return value.toLowerCase();
    },
  };
}

export function oneOf<T extends string>(label: string, values: readonly T[], o: { required?: boolean } = {}): Field {
  return {
    label,
    required: o.required ?? false,
    parse(value) {
      if (typeof value !== 'string' || !values.includes(value as T)) throw bad(label, 'opção inválida.');
      return value;
    },
  };
}

// Link de imagem: sempre https. Uploads do painel vão para o Vercel Blob; links externos (produtos importados) também valem.
export function imageUrl(label: string, o: { nullable?: boolean } = { nullable: true }): Field {
  return {
    label,
    required: false,
    parse(value) {
      if ((value === null || value === undefined || value === '') && o.nullable !== false) return null;
      if (typeof value !== 'string' || value.length > 1000) throw bad(label, 'link inválido.');
      let url: URL;
      try {
        url = new URL(value.trim());
      } catch {
        throw bad(label, 'link inválido.');
      }
      if (url.protocol !== 'https:') throw bad(label, 'o link precisa começar com https://');
      return url.toString();
    },
  };
}

// Número só com dígitos (WhatsApp, CEP). Aceita máscara na entrada.
export function digits(label: string, o: { min: number; max: number; nullable?: boolean }): Field {
  return {
    label,
    required: false,
    parse(value) {
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
        if (o.nullable) return null;
        throw bad(label, 'preencha este campo.');
      }
      if (typeof value !== 'string' && typeof value !== 'number') throw bad(label, 'valor inválido.');
      const d = String(value).replace(/\D/g, '');
      if (d.length < o.min || d.length > o.max) throw bad(label, o.min === o.max ? `precisa ter ${o.min} dígitos.` : `use de ${o.min} a ${o.max} dígitos.`);
      return d;
    },
  };
}

export function instagram(label: string): Field {
  return {
    label,
    required: false,
    parse(value) {
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
      if (typeof value !== 'string') throw bad(label, 'valor inválido.');
      const handle = value
        .trim()
        .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
        .replace(/[/?#].*$/, '')
        .replace(/^@/, '');
      if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) throw bad(label, 'use só letras, números, ponto e sublinhado.');
      return handle;
    },
  };
}

export function state(label: string): Field {
  return {
    label,
    required: false,
    parse(value) {
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
      const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
      if (!/^[A-Z]{2}$/.test(s)) throw bad(label, 'use a sigla com 2 letras (ex.: MG).');
      return s;
    },
  };
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function openingHours(label: string): Field {
  return {
    label,
    required: false,
    cast: 'jsonb',
    parse(value) {
      if (!value || typeof value !== 'object') throw bad(label, 'valor inválido.');
      const out: Row = {};
      for (const day of DAYS) {
        const d = (value as Row)[day];
        if (!d || typeof d !== 'object' || typeof d.open !== 'boolean' || !TIME.test(d.start) || !TIME.test(d.end)) {
          throw bad(label, 'confira os horários de cada dia (formato 09:00).');
        }
        out[day] = { open: d.open, start: d.start, end: d.end };
      }
      return JSON.stringify(out);
    },
  };
}

export function imageList(label: string, max: number): Field {
  const one = imageUrl(label, { nullable: false });
  return {
    label,
    required: false,
    cast: 'jsonb',
    parse(value) {
      if (!Array.isArray(value)) throw bad(label, 'lista inválida.');
      if (value.length > max) throw bad(label, `use no máximo ${max} imagens.`);
      return JSON.stringify(value.map((v) => one.parse(v)));
    },
  };
}

// Banner / link do site: caminho interno (/bebidas, /#contato) ou https://
export function siteLink(label: string): Field {
  return {
    label,
    required: false,
    parse(value) {
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
      if (typeof value !== 'string') throw bad(label, 'link inválido.');
      const s = value.trim();
      if (s.length > 500 || !/^(\/(?!\/)|https:\/\/)/.test(s)) throw bad(label, 'comece com / (página do site) ou https://');
      return s;
    },
  };
}

type ParseOpts = { partial?: boolean };

// Valida o corpo da requisição contra o spec e devolve só as colunas conhecidas.
export function parse(spec: Spec, body: Row, { partial = false }: ParseOpts = {}): { values: Row; cast: Record<string, string> } {
  const values: Row = {};
  const cast: Record<string, string> = {};
  for (const [column, field] of Object.entries(spec)) {
    if (!(column in body)) {
      if (!partial && field.required) throw bad(field.label, 'preencha este campo.');
      continue;
    }
    values[column] = field.parse(body[column]);
    if (field.cast) cast[column] = field.cast;
  }
  return { values, cast };
}
