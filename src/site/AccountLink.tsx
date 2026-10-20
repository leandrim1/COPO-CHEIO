import { User } from 'lucide-react';
import { useCustomer } from './customer';

// "Login" / "Minha conta" no cabeçalho da página Bebidas. Não existe login novo aqui: é só um atalho para /conta, a tela que o site já tem
// (entrar, criar conta, confirmar o e-mail, Meus pedidos, Sair). Quem já tem sessão (cookie HttpOnly, conferido em /api/account/me) vê
// "Minha conta" e cai direto nos dados e nos pedidos, sem digitar a senha de novo. Sem `?voltar=`: depois de entrar, o cliente fica na conta
// (e não volta para a Bebidas, evitando vai e volta). O acompanhamento sem cadastro continua em /acompanhar-pedido, intacto.

export function AccountLink({ className = '' }: { className?: string }) {
  const { status, customer } = useCustomer();
  // Enquanto não se sabe se há sessão, nada aparece (melhor do que mostrar "Login" para quem já está logado e trocar depois).
  if (status === 'idle' || status === 'loading') return null;
  const loggedIn = status === 'in' && customer !== null;
  return (
    <a
      href="/conta"
      data-account-link={loggedIn ? 'in' : 'out'}
      // Deslogado, o nome acessível é o próprio texto visível ("Login"); a dica explica o resto. Logado, o nome é sempre "Minha conta" (de 360 a 400 px o texto
      // visível é só "Conta" e abaixo disso só o ícone; "Minha conta" contém o que se vê).
      aria-label={loggedIn ? 'Minha conta' : undefined}
      title={loggedIn ? undefined : 'Entrar na sua conta ou criar uma conta'}
      className={`tap inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/20 bg-black px-3.5 text-sm font-semibold text-white transition-colors hover:border-[#2563FF] hover:bg-[#145CFF]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${className}`}
    >
      {loggedIn ? (
        <>
          <User className="h-4 w-4 text-[#2563FF]" aria-hidden="true" />
          {/* O nome da loja não pode quebrar por causa do botão: de 360 a 400 px vai só "Conta" e abaixo de 360 px só o ícone (o nome acessível é sempre "Minha conta"). */}
          <span className="max-[400px]:hidden">Minha conta</span>
          <span className="min-[401px]:hidden max-[359px]:hidden">Conta</span>
        </>
      ) : (
        'Login'
      )}
    </a>
  );
}
