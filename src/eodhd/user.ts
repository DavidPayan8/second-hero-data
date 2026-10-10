import { config } from '../config.js';

// Consulta de cuota (1 llamada). No imprime nombre ni email.
const res = await fetch(`${config.eodhdBase}/internal-user?fmt=json&api_token=${config.eodhdApiKey}`);
const text = await res.text();
console.log('HTTP', res.status);
try {
  const { name, email, inviteToken, ...rest } = JSON.parse(text);
  void name; void email; void inviteToken;
  console.log(JSON.stringify(rest, null, 1).slice(0, 2500));
} catch {
  console.log(text.slice(0, 300));
}
