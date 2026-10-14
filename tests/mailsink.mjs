// Servidor SMTP de mentira: guarda os e-mails que o sistema "envia" para os testes lerem o código.
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

// Texto de cada cabeçalho como chegou (nome em minúsculas; linhas dobradas juntadas; repetidos separados por quebra de linha).
function rawHeaders(lines = []) {
  const out = {};
  for (const { key, line } of lines) {
    const value = String(line).slice(String(line).indexOf(':') + 1).replace(/\r?\n\s+/g, ' ').trim();
    out[key] = key in out ? `${out[key]}\n${value}` : value;
  }
  return out;
}

export async function startMailSink(port = 0) {
  const messages = [];
  // failure: 'rcpt' | 'auth' | 'down' | 'temp' (451 em todo destinatário) | 'data' (554 5.7.1 depois do conteúdo) | null
  const mode = { failure: null, delayMs: 0 };
  // Quantas vezes o servidor foi realmente procurado (para provar que uma mensagem bloqueada nem chega a tentar o envio).
  const stats = { connect: 0, rcpt: 0, data: 0 };
  const server = new SMTPServer({
    secure: false,
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onConnect(session, cb) {
      stats.connect += 1;
      if (mode.failure === 'down') return cb(new Error('421 servico indisponivel'));
      cb();
    },
    onAuth(auth, session, cb) {
      if (mode.failure === 'auth' || auth.password !== 'secret') return cb(new Error('535 credenciais invalidas'));
      cb(null, { user: auth.username });
    },
    onRcptTo(address, session, cb) {
      stats.rcpt += 1;
      if (mode.failure === 'rcpt' || /^(naoexiste|nobox)/.test(address.address)) {
        const err = new Error('550 5.1.1 caixa postal inexistente');
        err.responseCode = 550;
        return cb(err);
      }
      // Recusas com os códigos que servidores reais usam (para provar a classificação: temporário, caixa cheia, política).
      if (mode.failure === 'temp' || /^soft-/.test(address.address)) {
        const err = new Error('451 4.7.1 greylisted, tente mais tarde');
        err.responseCode = 451;
        return cb(err);
      }
      if (/^full-/.test(address.address)) {
        const err = new Error('552 5.2.2 caixa cheia');
        err.responseCode = 552;
        return cb(err);
      }
      cb();
    },
    onData(stream, session, cb) {
      stats.data += 1;
      simpleParser(stream)
        .then(async (m) => {
          if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
          if (mode.failure === 'data' || (m.to?.value ?? []).some((a) => /^policy-/.test(a.address))) {
            const err = new Error('554 5.7.1 mensagem recusada pela política do servidor');
            err.responseCode = 554;
            throw err;
          }
          messages.push({
            to: (m.to?.value ?? []).map((a) => a.address.toLowerCase()),
            from: m.from?.text,
            subject: m.subject,
            text: m.text,
            html: m.html || '',
            // O mailparser agrupa os cabeçalhos "List-*" num objeto "list": os testes precisam do texto de cada cabeçalho como foi enviado.
            headers: { ...Object.fromEntries(m.headers), ...rawHeaders(m.headerLines) },
            at: Date.now(),
          });
          cb();
        })
        .catch(cb);
    },
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, messages, mode, stats, port: server.server.address().port };
}
