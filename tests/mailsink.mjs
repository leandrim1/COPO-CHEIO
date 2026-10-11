// Servidor SMTP de mentira: guarda os e-mails que o sistema "envia" para os testes lerem o código.
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

export async function startMailSink(port = 0) {
  const messages = [];
  const mode = { failure: null, delayMs: 0 }; // failure: 'rcpt' | 'auth' | 'down' | null
  const server = new SMTPServer({
    secure: false,
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onConnect(session, cb) {
      if (mode.failure === 'down') return cb(new Error('421 servico indisponivel'));
      cb();
    },
    onAuth(auth, session, cb) {
      if (mode.failure === 'auth' || auth.password !== 'secret') return cb(new Error('535 credenciais invalidas'));
      cb(null, { user: auth.username });
    },
    onRcptTo(address, session, cb) {
      if (mode.failure === 'rcpt' || /^(naoexiste|nobox)/.test(address.address)) {
        const err = new Error('550 5.1.1 caixa postal inexistente');
        err.responseCode = 550;
        return cb(err);
      }
      cb();
    },
    onData(stream, session, cb) {
      simpleParser(stream)
        .then(async (m) => {
          if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
          messages.push({
            to: (m.to?.value ?? []).map((a) => a.address.toLowerCase()),
            from: m.from?.text,
            subject: m.subject,
            text: m.text,
            html: m.html || '',
            headers: Object.fromEntries(m.headers),
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
  return { server, messages, mode, port: server.server.address().port };
}
