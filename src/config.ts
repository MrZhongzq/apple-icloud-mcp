import dotenv from 'dotenv';

dotenv.config();

export interface AccountConfig {
  accountId: string;
  email: string;
  appPass: string;
  allowCalendarRead: boolean;
  allowCalendarWrite: boolean;
  allowNoteRead: boolean;
  allowNoteWrite: boolean;
  allowMailRead: boolean;
  allowMailWrite: boolean;
}

export const getConfig = (): AccountConfig[] => {
  const multipleAccountEnable = process.env.multiple_account_enable === '1';
  const accounts: AccountConfig[] = [];

  const maxAccounts = multipleAccountEnable ? 5 : 1;

  for (let i = 1; i <= maxAccounts; i++) {
    const suffix = i === 1 ? '' : `${i}`;
    const email = process.env[`icloud_account${suffix}`];
    const appPass = process.env[`icloud_app_pass${suffix}`];

    if (!email || !appPass) {
      if (i === 1) {
        console.warn(`Warning: icloud_account${suffix} or icloud_app_pass${suffix} not provided.`);
      }
      continue;
    }

    accounts.push({
      accountId: `account_${i}`,
      email,
      appPass,
      allowCalendarRead: process.env[`allow_calendar${suffix}_read`] !== 'false',
      allowCalendarWrite: process.env[`allow_calendar${suffix}_write`] !== 'false',
      allowNoteRead: process.env[`allow_note${suffix}_read`] !== 'false',
      allowNoteWrite: process.env[`allow_note${suffix}_write`] !== 'false',
      allowMailRead: process.env[`allow_mail${suffix}_read`] !== 'false',
      allowMailWrite: process.env[`allow_mail${suffix}_write`] !== 'false',
    });
  }

  return accounts;
};

export const getAccountConfig = (email: string): AccountConfig | undefined => {
  return getConfig().find((acc) => acc.email === email);
};

export const getPort = (): number => {
  return parseInt(process.env.PORT || '17733', 10);
};
