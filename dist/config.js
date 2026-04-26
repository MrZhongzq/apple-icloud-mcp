import dotenv from 'dotenv';
dotenv.config();
export const getConfig = () => {
    const multipleAccountEnable = process.env.multiple_account_enable === '1';
    const accounts = [];
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
        const sender = process.env[`icloud_sender${suffix}`] || email;
        accounts.push({
            accountId: `account_${i}`,
            email,
            sender,
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
export const getAccountConfig = (email) => {
    return getConfig().find((acc) => acc.email === email);
};
export const getPort = () => {
    return parseInt(process.env.PORT || '17733', 10);
};
