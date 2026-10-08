import type { Session } from '@supabase/supabase-js';
import {
  Boxes,
  ExternalLink,
  Image as ImageIcon,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Package,
  Settings,
  ShoppingBag,
  Tags,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { money } from '../lib/format';
import { navigate } from '../lib/router';
import type { AdminUser, Order } from '../lib/types';
import { admin, supabaseConfigured } from './client';
import { ConfirmProvider, IconButton, Spinner, ToastProvider, cx, useToast } from './ui';
import BannersPage from './Banners';
import CategoriesPage from './Categories';
import DashboardPage from './Dashboard';
import LoginPage from './Login';
import { OrderDetailPage, OrdersPage } from './Orders';
import { ProductFormPage, ProductsPage } from './Products';
import SettingsPage from './Settings';
import SitePage from './Site';
import StockPage from './Stock';

// ---- Sessão e administrador logado ------------------------------------------------------------

type AdminSession = { session: Session; user: AdminUser };
const AdminContext = createContext<AdminSession | null>(null);
export const useAdmin = () => {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin fora do painel');
  return value;
};

// ---- Pedidos em tempo real (Supabase Realtime) ------------------------------------------------

type LiveOrders = {
  // Muda a cada pedido novo ou alterado: as telas recarregam quando ele muda.
  version: number;
  newCount: number;
  sound: boolean;
  setSound: (on: boolean) => void;
  connected: boolean;
};
const LiveContext = createContext<LiveOrders>({ version: 0, newCount: 0, sound: true, setSound: () => {}, connected: false });
export const useLiveOrders = () => useContext(LiveContext);

const SOUND_KEY = 'copocheio:admin-som';
let audio: AudioContext | null = null;

// Garante que o som possa tocar: navegadores só liberam áudio depois de um clique.
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

export function playOrderChime() {
  unlockAudio();
  if (!audio) return;
  const start = audio.currentTime + 0.02;
  [880, 1174.66, 1567.98].forEach((freq, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    const t = start + i * 0.16;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(gain).connect(audio!.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  });
}

function LiveOrdersProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const { session } = useAdmin();
  const [version, setVersion] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [sound, setSoundState] = useState(() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const setSound = useCallback((on: boolean) => {
    setSoundState(on);
    if (on) unlockAudio();
    try {
      localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }, []);

  const countNew = useCallback(async () => {
    const { count } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('order_status', 'new');
    setNewCount(count ?? 0);
  }, []);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    void countNew();
    admin.realtime.setAuth(session.access_token);
    const channel = admin
      .channel('painel-pedidos')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (payload) => {
        const order = payload.new as Order;
        setVersion((v) => v + 1);
        void countNew();
        if (soundRef.current) playOrderChime();
        toast.push({
          kind: 'order',
          title: 'NOVO PEDIDO',
          description: `Pedido #${order.order_number} recebido\n${money(Number(order.total))}`,
          action: { label: 'Ver pedido', onClick: () => navigate(`/admin/pedidos/${order.order_number}`) },
        });
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, () => {
        setVersion((v) => v + 1);
        void countNew();
      })
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'));

    // Ao voltar para a aba, confere se algo mudou enquanto ela estava em segundo plano.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setVersion((v) => v + 1);
        void countNew();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void admin.removeChannel(channel);
    };
    // A sessão é renovada sozinha; o canal não precisa ser recriado a cada token.
  }, [countNew]);

  // Título da aba com os pedidos novos: "(2) Pedidos – Painel".
  useEffect(() => {
    const base = 'Painel – COPO CHEIO';
    document.title = newCount > 0 ? `(${newCount}) Novo pedido – ${base}` : base;
  }, [newCount]);

  const value = useMemo(() => ({ version, newCount, sound, setSound, connected }), [version, newCount, sound, setSound, connected]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

// ---- Layout -----------------------------------------------------------------------------------

const MENU = [
  { href: '/admin/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/pedidos', label: 'Pedidos', icon: ShoppingBag },
  { href: '/admin/produtos', label: 'Produtos', icon: Package },
  { href: '/admin/categorias', label: 'Categorias', icon: Tags },
  { href: '/admin/estoque', label: 'Estoque', icon: Boxes },
  { href: '/admin/site', label: 'Site', icon: Monitor },
  { href: '/admin/banners', label: 'Banners', icon: ImageIcon },
  { href: '/admin/configuracoes', label: 'Configurações', icon: Settings },
];

function Sidebar({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const { newCount } = useLiveOrders();
  const { user } = useAdmin();
  return (
    <div className="flex h-full flex-col">
      <a href="/admin/dashboard" onClick={onNavigate} className="flex items-center gap-3 px-5 pb-6 pt-5">
        <img src="/logo.png" alt="" width={40} height={40} className="h-10 w-10 rounded-full object-contain ring-1 ring-white/15 shadow-[0_0_20px_rgba(20,92,255,0.5)]" />
        <span className="leading-none">
          <span className="block text-[15px] font-black tracking-tight text-white">
            COPO <span className="text-[#2563FF]">CHEIO</span>
          </span>
          <span className="mt-1 block text-[10px] font-bold tracking-[0.2em] text-white/45">PAINEL</span>
        </span>
      </a>
      <nav aria-label="Menu do painel" className="flex-1 space-y-1 overflow-y-auto px-3">
        {MENU.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <a
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]',
                active
                  ? 'bg-[#145CFF] text-white shadow-[0_8px_24px_-10px_rgba(20,92,255,0.9)]'
                  : 'text-white/60 hover:bg-white/[0.05] hover:text-white',
              )}
            >
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              <span className="flex-1">{label}</span>
              {href === '/admin/pedidos' && newCount > 0 && (
                <span
                  className={cx(
                    'grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-black',
                    active ? 'bg-white text-[#145CFF]' : 'bg-[#145CFF] text-white shadow-[0_0_12px_rgba(20,92,255,0.8)]',
                  )}
                  aria-label={`${newCount} novos`}
                >
                  {newCount}
                </span>
              )}
            </a>
          );
        })}
      </nav>
      <div className="m-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3">
        <p className="truncate text-sm font-bold text-white">{user.name}</p>
        <p className="truncate text-xs text-white/45">
          {user.email} · {user.role === 'owner' ? 'Owner' : 'Admin'}
        </p>
      </div>
    </div>
  );
}

function Layout({ pathname, title, children }: { pathname: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { sound, setSound, connected } = useLiveOrders();
  const toast = useToast();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const logout = async () => {
    await admin.auth.signOut();
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className="min-h-[100dvh] bg-[#07090E] text-white">
      {/* Sidebar fixa no desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-white/[0.06] bg-[#0A0D14] lg:block">
        <Sidebar pathname={pathname} />
      </aside>

      {/* Gaveta no celular/tablet */}
      <div className={cx('fixed inset-0 z-50 lg:hidden', open ? 'visible' : 'invisible')} aria-hidden={!open} inert={!open}>
        <div className={cx('absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity', open ? 'opacity-100' : 'opacity-0')} onClick={() => setOpen(false)} />
        <aside
          className={cx(
            'absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-white/[0.06] bg-[#0A0D14] shadow-2xl transition-transform duration-300',
            open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <IconButton label="Fechar menu" className="absolute right-3 top-4" onClick={() => setOpen(false)}>
            <X className="h-5 w-5" aria-hidden="true" />
          </IconButton>
          <Sidebar pathname={pathname} onNavigate={() => setOpen(false)} />
        </aside>
      </div>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-white/[0.06] bg-[#07090E]/85 px-3 backdrop-blur-xl sm:px-6">
          <IconButton label="Abrir menu" className="lg:hidden" onClick={() => setOpen(true)}>
            <Menu className="h-5 w-5" aria-hidden="true" />
          </IconButton>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-white/80">{title}</p>
          <span
            className={cx('hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 sm:inline-flex', connected ? 'text-emerald-300 ring-emerald-400/30' : 'text-white/45 ring-white/15')}
            title={connected ? 'Recebendo pedidos em tempo real' : 'Reconectando...'}
          >
            <span className={cx('h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-emerald-400' : 'bg-white/40')} aria-hidden="true" />
            {connected ? 'Ao vivo' : 'Conectando'}
          </span>
          <IconButton
            label={sound ? 'Desligar som de novos pedidos' : 'Ligar som de novos pedidos'}
            aria-pressed={sound}
            onClick={() => {
              setSound(!sound);
              toast.push({ kind: 'info', title: sound ? 'Som de novos pedidos desligado' : 'Som de novos pedidos ligado' });
              if (!sound) playOrderChime();
            }}
          >
            {sound ? <Volume2 className="h-5 w-5" aria-hidden="true" /> : <VolumeX className="h-5 w-5" aria-hidden="true" />}
          </IconButton>
          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-white/70 hover:bg-white/[0.06] hover:text-white sm:inline-flex"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Ver site
          </a>
          <IconButton label="Sair" onClick={() => void logout()}>
            <LogOut className="h-5 w-5" aria-hidden="true" />
          </IconButton>
        </header>
        <main className="mx-auto w-full max-w-7xl px-3 py-5 sm:px-6 sm:py-7">{children}</main>
      </div>
    </div>
  );
}

// ---- Rotas do painel --------------------------------------------------------------------------

function route(pathname: string): { title: string; page: ReactNode } | null {
  const parts = pathname.split('/').filter(Boolean).slice(1); // sem "admin"
  const [section, id] = parts;
  switch (section) {
    case 'dashboard':
      return { title: 'Dashboard', page: <DashboardPage /> };
    case 'pedidos':
      return id ? { title: `Pedido #${id}`, page: <OrderDetailPage number={id} /> } : { title: 'Pedidos', page: <OrdersPage /> };
    case 'produtos':
      return id ? { title: id === 'novo' ? 'Novo produto' : 'Editar produto', page: <ProductFormPage id={id} key={id} /> } : { title: 'Produtos', page: <ProductsPage /> };
    case 'categorias':
      return { title: 'Categorias', page: <CategoriesPage /> };
    case 'estoque':
      return { title: 'Estoque', page: <StockPage /> };
    case 'site':
      return { title: 'Site', page: <SitePage /> };
    case 'banners':
      return { title: 'Banners', page: <BannersPage /> };
    case 'configuracoes':
      return { title: 'Configurações', page: <SettingsPage /> };
    default:
      return null;
  }
}

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="grid min-h-[100dvh] place-items-center bg-[#07090E] px-4 text-white">{children}</div>;
}

function NotConfigured() {
  return (
    <FullScreen>
      <div className="max-w-lg rounded-3xl border border-white/10 bg-[#0C1018] p-8">
        <h1 className="text-xl font-black">Conecte o Supabase</h1>
        <p className="mt-2 text-sm text-white/65">
          O painel precisa das variáveis <code className="text-[#8FB1FF]">VITE_SUPABASE_URL</code> e <code className="text-[#8FB1FF]">VITE_SUPABASE_ANON_KEY</code>. Veja
          o passo a passo no README do projeto.
        </p>
      </div>
    </FullScreen>
  );
}

function NoAccess({ email }: { email?: string }) {
  return (
    <FullScreen>
      <div className="max-w-md rounded-3xl border border-white/10 bg-[#0C1018] p-8 text-center">
        <h1 className="text-xl font-black">Sem acesso ao painel</h1>
        <p className="mt-2 text-sm text-white/65">A conta {email ? <strong className="text-white">{email}</strong> : ''} não é um administrador ativo da loja.</p>
        <button
          type="button"
          onClick={() => void admin.auth.signOut().then(() => navigate('/admin/login', { replace: true }))}
          className="mt-6 rounded-xl bg-[#145CFF] px-5 py-2.5 text-sm font-bold hover:bg-[#2563FF]"
        >
          Entrar com outra conta
        </button>
      </div>
    </FullScreen>
  );
}

export default function AdminApp({ pathname }: { pathname: string }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [adminUser, setAdminUser] = useState<AdminUser | null | undefined>(undefined);
  const userId = session?.user.id;

  useEffect(() => {
    if (!supabaseConfigured) return;
    void admin.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = admin.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!userId) {
      setAdminUser(session === null ? null : undefined);
      return;
    }
    let alive = true;
    setAdminUser(undefined);
    void admin
      .from('admin_users')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setAdminUser(data && (data as AdminUser).active ? (data as AdminUser) : null);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  const isLogin = pathname === '/admin/login';
  const current = route(pathname);

  // Redirecionamentos: sem sessão → login; logado no login → dashboard; caminho desconhecido → dashboard.
  useEffect(() => {
    if (!supabaseConfigured || session === undefined) return;
    if (!session && !isLogin) navigate('/admin/login', { replace: true });
    else if (session && adminUser && (isLogin || !current)) navigate('/admin/dashboard', { replace: true });
  }, [session, adminUser, isLogin, current]);

  useEffect(() => {
    document.title = 'Painel – COPO CHEIO';
    document.documentElement.style.colorScheme = 'dark';
  }, []);

  if (!supabaseConfigured) return <NotConfigured />;
  if (session === undefined) return <FullScreen><Spinner label="Carregando o painel" /></FullScreen>;
  if (isLogin && !(session && adminUser)) {
    return (
      <ToastProvider>
        <LoginPage checking={Boolean(session) && adminUser === undefined} />
      </ToastProvider>
    );
  }
  if (!session || adminUser === undefined || !current) return <FullScreen><Spinner label="Carregando o painel" /></FullScreen>;
  if (adminUser === null) return <NoAccess email={session.user.email} />;

  return (
    <AdminContext.Provider value={{ session, user: adminUser }}>
      <ToastProvider>
        <ConfirmProvider>
          <LiveOrdersProvider>
            <Layout pathname={pathname} title={current.title}>
              {current.page}
            </Layout>
          </LiveOrdersProvider>
        </ConfirmProvider>
      </ToastProvider>
    </AdminContext.Provider>
  );
}
