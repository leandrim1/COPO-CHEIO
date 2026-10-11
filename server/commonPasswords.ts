// Senhas fáceis de adivinhar: as mais usadas no mundo e no Brasil (listas públicas de vazamentos) e palavras que quem cria a
// senha costuma usar (nome do lugar, da loja, "senha"...). Só entram as que passam do mínimo de 8 caracteres, porque as
// menores já são barradas pelo tamanho. A comparação é sempre em minúsculas e sem acentos.
//
// Duas listas: SENHAS_FRACAS (a senha inteira) e BASES_FRACAS (a parte de letras, quando o resto são só números ou símbolos no
// final: "brasil2026", "senha@123", "copocheio1" caem aqui).

export const WEAK_PASSWORDS: ReadonlySet<string> = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '987654321', '0987654321', '11111111', '22222222', '33333333', '44444444',
  '55555555', '66666666', '77777777', '88888888', '99999999', '00000000', '111111111', '123123123', '12341234', '12121212',
  '123456a', '1234qwer', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', '1qazxsw2', 'qwertyui', 'qwertyuiop', 'qwerty123', 'qwerty1234',
  'qwerty12', 'qwer1234', 'asdfghjk', 'asdfghjkl', 'asdf1234', 'zxcvbnm1', 'zxcvbnm123', 'zaq12wsx', 'abcd1234', 'abcdefgh',
  'abcdefghi', 'abc12345', 'abc123456', 'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  'pass1234', 'letmein1', 'letmein123', 'welcome1', 'welcome123', 'admin123', 'admin1234', 'administrador', 'administrator',
  'adminadmin', 'admin@123', 'admin@1234', 'root1234', 'master123', 'iloveyou', 'iloveyou1', 'monkey123', 'dragon123', 'football',
  'baseball', 'sunshine', 'princess', 'trustno1', 'superman', 'whatever', 'shadow123', 'michael1', 'jordan23', 'starwars',
  'senha123', 'senha1234', 'senha12345', 'senha@123', 'senha@1234', 'senha#123', 'senhasenha', 'minhasenha', 'minhasenha1',
  'minhasenha123', 'senhaforte', 'senhasegura', 'senha2024', 'senha2025', 'senha2026', 'mudar123', 'mudar@123', 'mudar1234',
  'trocar123', 'trocar@123', 'brasil123', 'brasil2024', 'brasil2025', 'brasil2026', 'brasileiro', 'flamengo', 'flamengo1',
  'flamengo123', 'corinthians', 'palmeiras', 'palmeiras1', 'saopaulo', 'santos123', 'vasco1898', 'gremio123', 'cruzeiro', 'atletico',
  'botafogo', 'fluminense', 'internacional', 'corinthians1', 'timaobr', 'amoremeu', 'teamo123', 'teamo1234', 'te@mo123',
  'meuamor1', 'minhavida', 'deusefiel', 'deus1234', 'deusefiel1', 'jesus123', 'jesus1234', 'jesuscristo', 'familia123',
  'familia1', 'bemvindo', 'bemvindo1', 'bemvindo123', 'entrar123', 'acesso123', 'acesso@123', 'login123', 'usuario123',
  'usuario1', 'empresa123', 'empresa1', 'loja1234', 'loja12345', 'bebidas123', 'bebidas1', 'disk1234', 'copo1234', 'copocheio',
  'copocheio1', 'copocheio123', 'copocheio@123', 'copocheio2024', 'copocheio2025', 'copocheio2026', 'copo cheio', 'copo@cheio',
  'diskbebidas', 'disk bebidas', 'diskbebidas1', 'diskbebidas123', 'uberlandia', 'uberaba123', 'minasgerais', 'goiania123',
  'saopaulo1', 'riodejaneiro', 'vitoria123', 'felicidade', 'felicidade1', 'saudade123', 'chocolate', 'chocolate1', 'cachorro',
  'cachorro1', 'gatinho123', 'gatinha123', 'passarinho', 'borboleta', 'princesa1', 'princesa123', 'estrela123', 'mariana123',
  'gabriel123', 'rafael123', 'lucas1234', 'joao1234', 'maria1234', 'jose12345', 'pedro1234', 'ana123456', 'carlos123', 'marcos123',
  'qazwsxedc', 'qazwsx123', 'qweasdzxc', 'qweasd123', 'q1w2e3r4', 'q1w2e3r4t5', 'a1b2c3d4', 'a1b2c3d4e5', '1a2b3c4d', 'abcabcabc',
  'aaaaaaaa', 'aaaa1111', 'aaaaaaa1', 'qqqqqqqq', 'zzzzzzzz', 'asdasdasd', 'qweqweqwe', '123qweasd', '123qwe123', '123qwe!@#',
  '1234abcd', '12345abc', '12345qwert', '147258369', '123654789', '159753456', '741852963', '963852741', '321654987', '147852369',
  '0123456789', '1029384756', '1357924680', '2468013579', '654321654', '112233445', '1122334455', '11223344', '12344321', '123321123',
  '10203040', '102030405', '1020304050', '01234567', '09876543', '98765432', '87654321', '76543210', '23456789', '34567890',
]);

export const WEAK_BASES: ReadonlySet<string> = new Set([
  'senha', 'senhas', 'senhaforte', 'minhasenha', 'password', 'passw0rd', 'qwerty', 'qwertyui', 'asdfgh', 'asdfghjk', 'zxcvbn',
  'abcdef', 'abcdefgh', 'admin', 'administrador', 'administrator', 'root', 'master', 'teste', 'test', 'testing', 'login', 'user',
  'usuario', 'acesso', 'entrar', 'mudar', 'trocar', 'bemvindo', 'welcome', 'letmein', 'iloveyou', 'teamo', 'amor', 'meuamor',
  'brasil', 'brasileiro', 'brazil', 'flamengo', 'corinthians', 'palmeiras', 'saopaulo', 'santos', 'vasco', 'gremio', 'cruzeiro',
  'atletico', 'botafogo', 'fluminense', 'internacional', 'familia', 'deus', 'deusefiel', 'jesus', 'felicidade', 'saudade',
  'empresa', 'loja', 'bebidas', 'bebida', 'disk', 'diskbebidas', 'copo', 'copocheio', 'copocheiodisk', 'uberlandia', 'uberaba',
  'minas', 'goiania', 'vitoria', 'chocolate', 'cachorro', 'gatinho', 'gatinha', 'princesa', 'estrela', 'monkey', 'dragon',
  'football', 'baseball', 'sunshine', 'princess', 'superman', 'shadow', 'michael', 'jordan', 'starwars', 'trustno',
]);
