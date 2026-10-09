import { AccountPage, MyOrderPage, MyOrdersPage, RecoverPage, ResetPage, VerifyLinkPage } from './Account';
import { LookupPage, TrackingPage } from './Tracking';

// Páginas do cliente (acompanhamento e conta). Ficam num pacote à parte: a página inicial não carrega nada disso.
export type CustomerPage =
  | { name: 'pedido'; token: string }
  | { name: 'acompanhar'; token: string | null }
  | { name: 'conta' }
  | { name: 'conta-pedidos' }
  | { name: 'conta-pedido'; number: string }
  | { name: 'recuperar' }
  | { name: 'redefinir'; token: string }
  | { name: 'verificar'; token: string };

export default function CustomerPages({ page }: { page: CustomerPage }) {
  switch (page.name) {
    case 'pedido':
      // key: trocar de pedido recomeça o acompanhamento do zero
      return <TrackingPage key={page.token} token={page.token} confirmation />;
    case 'acompanhar':
      return page.token ? <TrackingPage key={page.token} token={page.token} confirmation={false} /> : <LookupPage />;
    case 'conta':
      return <AccountPage />;
    case 'conta-pedidos':
      return <MyOrdersPage />;
    case 'conta-pedido':
      return <MyOrderPage key={page.number} number={page.number} />;
    case 'recuperar':
      return <RecoverPage />;
    case 'redefinir':
      return <ResetPage token={page.token} />;
    case 'verificar':
      return <VerifyLinkPage key={page.token} token={page.token} />;
  }
}
