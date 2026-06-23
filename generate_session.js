require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

(async () => {
  const apiId = parseInt(process.env.TG_API_ID || '0');
  const apiHash = process.env.TG_API_HASH || '';

  if (!apiId || !apiHash) {
    console.log('TG_API_ID da TG_API_HASH ba a saita su a .env ba.');
    console.log('Samu su daga https://my.telegram.org sannan ka sake gwada.');
    process.exit(1);
  }

  console.log('Ana shigowa cikin Telegram (login)...');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => await input.text('Lambar waya (misali +234...): '),
    password: async () => await input.text('2FA Password (idan babu, danna Enter): '),
    phoneCode: async () => await input.text('Code da Telegram ya turo maka: '),
    onError: (err) => console.log('Error:', err),
  });

  console.log('An shiga cikin nasara!');
  console.log('Session string dinka (KWAFA DUKKANSA):');
  console.log(client.session.save());
  console.log('Manna wannan a .env a matsayin: TG_SESSION=<abinda ka kwafa>');

  process.exit(0);
})();
