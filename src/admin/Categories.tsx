import { ArrowDown, ArrowUp, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { friendlyError } from '../lib/supabase';
import type { Category } from '../lib/types';
import { admin } from './client';
import { Badge, Button, Card, EmptyState, ErrorState, Field, INPUT, IconButton, Modal, PageHeader, Skeleton, Switch, useConfirm, useToast } from './ui';

type Row = Category & { products: number };

export default function CategoriesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; name: string; active: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState('');

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([admin.from('categories').select('*').order('position').order('name'), admin.from('products').select('category_id')]);
    if (c.error) {
      setError(true);
      return;
    }
    setError(false);
    const counts = new Map<string, number>();
    for (const { category_id } of (p.data ?? []) as { category_id: string | null }[]) if (category_id) counts.set(category_id, (counts.get(category_id) ?? 0) + 1);
    setRows((c.data as Category[]).map((cat) => ({ ...cat, products: counts.get(cat.id) ?? 0 })));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      setNameError('Informe o nome.');
      return;
    }
    setSaving(true);
    const position = rows?.length ? Math.max(...rows.map((r) => r.position)) + 1 : 0;
    const { error: err } = editing.id
      ? await admin.from('categories').update({ name, active: editing.active }).eq('id', editing.id)
      : await admin.from('categories').insert({ name, active: editing.active, position });
    setSaving(false);
    if (err) {
      setNameError(err.code === '23505' ? 'Já existe uma categoria com esse nome.' : friendlyError(err, 'Não foi possível salvar a categoria.'));
      return;
    }
    toast.success(editing.id ? 'Categoria salva.' : 'Categoria criada.', 'O site já mostra a mudança.');
    setEditing(null);
    void load();
  };

  const toggle = async (row: Row, active: boolean) => {
    setRows((list) => list?.map((r) => (r.id === row.id ? { ...r, active } : r)) ?? null);
    const { error: err } = await admin.from('categories').update({ active }).eq('id', row.id);
    if (err) {
      setRows((list) => list?.map((r) => (r.id === row.id ? row : r)) ?? null);
      toast.error('Não foi possível atualizar a categoria.');
    } else toast.success(active ? 'Categoria ativada.' : 'Categoria desativada.', active ? undefined : 'Os produtos dela saíram do site.');
  };

  // Troca de lugar com a vizinha e grava a nova ordem.
  const move = async (index: number, delta: -1 | 1) => {
    if (!rows) return;
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    const reordered = next.map((r, i) => ({ ...r, position: i }));
    setRows(reordered);
    const changed = reordered.filter((r, i) => rows.find((o) => o.id === r.id)?.position !== i);
    const results = await Promise.all(changed.map((r) => admin.from('categories').update({ position: r.position }).eq('id', r.id)));
    if (results.some((r) => r.error)) {
      toast.error('Não foi possível reordenar.');
      void load();
    } else toast.success('Ordem atualizada.');
  };

  const remove = async (row: Row) => {
    const ok = await confirm({
      title: `Excluir a categoria “${row.name}”?`,
      description: row.products
        ? `${row.products} produto(s) ficam sem categoria e passam a aparecer em “Outros”. Nenhum produto é apagado.`
        : 'A categoria não tem produtos.',
      confirmLabel: 'Excluir categoria',
    });
    if (!ok) return;
    const { error: err } = await admin.from('categories').delete().eq('id', row.id);
    if (err) toast.error('Não foi possível excluir a categoria.', friendlyError(err, ''));
    else {
      toast.success('Categoria excluída.');
      void load();
    }
  };

  return (
    <>
      <PageHeader
        title="Categorias"
        description="A ordem daqui é a ordem do cardápio no site."
        actions={
          <Button icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => (setNameError(''), setEditing({ name: '', active: true }))}>
            Nova categoria
          </Button>
        }
      />

      {error && !rows ? (
        <Card>
          <ErrorState message="Não foi possível carregar as categorias." onRetry={() => void load()} />
        </Card>
      ) : !rows ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Tags className="h-6 w-6" aria-hidden="true" />}
            title="Nenhuma categoria"
            description="Crie as categorias do seu cardápio (ex.: Cervejas, Refrigerantes, Gelo). Elas aparecem no site como filtros."
            action={<Button onClick={() => setEditing({ name: '', active: true })}>Criar categoria</Button>}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-white/[0.06]">
            {rows.map((row, i) => (
              <li key={row.id} className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-5">
                <div className="flex flex-col">
                  <IconButton label={`Subir ${row.name}`} disabled={i === 0} onClick={() => void move(i, -1)} className="h-7 w-7">
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton label={`Descer ${row.name}`} disabled={i === rows.length - 1} onClick={() => void move(i, 1)} className="h-7 w-7">
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{row.name}</p>
                  <p className="text-xs text-white/45">
                    {row.products} produto(s) {!row.active && <Badge className="ml-1">Oculta no site</Badge>}
                  </p>
                </div>
                <Switch checked={row.active} onChange={(v) => void toggle(row, v)} />
                <IconButton label={`Editar ${row.name}`} onClick={() => (setNameError(''), setEditing({ id: row.id, name: row.name, active: row.active }))}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton label={`Excluir ${row.name}`} onClick={() => void remove(row)} className="hover:text-rose-300">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        size="sm"
        title={editing?.id ? 'Editar categoria' : 'Nova categoria'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="categoria-form" loading={saving}>
              Salvar
            </Button>
          </>
        }
      >
        {editing && (
          <form id="categoria-form" onSubmit={save} noValidate className="space-y-4">
            <Field label="Nome" error={nameError} count={editing.name.length} max={40}>
              {(p) => (
                <input
                  {...p}
                  value={editing.name}
                  maxLength={40}
                  onChange={(e) => (setNameError(''), setEditing({ ...editing, name: e.target.value }))}
                  className={INPUT}
                  placeholder="Ex.: Cervejas"
                />
              )}
            </Field>
            <Switch checked={editing.active} onChange={(v) => setEditing({ ...editing, active: v })} label="Ativa no site" description="Desativada, a categoria e os produtos dela saem do site." />
          </form>
        )}
      </Modal>
    </>
  );
}
