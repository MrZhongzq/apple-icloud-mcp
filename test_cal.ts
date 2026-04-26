import { createDAVClient } from 'tsdav';

async function run() {
  const client = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com/',
    credentials: {
      username: 'zzqhmbb@gmail.com',
      password: 'mwve-yzhe-sdol-hfta',
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  const calendars = await client.fetchCalendars();
  console.log("Found calendars:", calendars.length);
  calendars.forEach(c => {
    console.log(`- ${c.displayName} (${c.url}) [ReadOnly: ${c.readOnly}] [Components: ${c.components?.join(',')}]`);
  });
}
run().catch(console.error);
