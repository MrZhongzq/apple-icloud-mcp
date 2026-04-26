import * as imaps from 'imap-simple';
import * as nodemailer from 'nodemailer';
import { AccountConfig } from '../config.js';

export const getImapConfig = (account: AccountConfig): imaps.ImapSimpleOptions => ({
  imap: {
    user: account.email,
    password: account.appPass,
    host: 'imap.mail.me.com',
    port: 993,
    tls: true,
    authTimeout: 10000,
  },
});

export const getSmtpTransporter = (account: AccountConfig) => {
  return nodemailer.createTransport({
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false, // true for 465, false for other ports
    requireTLS: true,
    auth: {
      user: account.email,
      pass: account.appPass,
    },
  });
};

export const listEmails = async (account: AccountConfig, folder: string = 'INBOX', limit: number = 10) => {
  if (!account.allowMailRead) throw new Error('Mail read permission denied.');
  
  let connection: imaps.ImapSimple | null = null;
  try {
    connection = await imaps.connect(getImapConfig(account));
    await connection.openBox(folder);

    const searchCriteria = ['ALL'];
    const fetchOptions = {
      bodies: ['HEADER'],
      struct: true,
      limit: limit,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    
    return messages.map((m) => {
      const headerPart = m.parts.find((p) => p.which === 'HEADER');
      const headers = headerPart?.body;
      return {
        uid: m.attributes.uid,
        date: m.attributes.date,
        subject: headers?.subject?.[0] || 'No Subject',
        from: headers?.from?.[0] || 'Unknown',
        to: headers?.to?.[0] || 'Unknown',
      };
    }).reverse().slice(0, limit); // latest first
  } finally {
    if (connection) connection.end();
  }
};

export const readEmail = async (account: AccountConfig, uid: number, folder: string = 'INBOX') => {
  if (!account.allowMailRead) throw new Error('Mail read permission denied.');

  let connection: imaps.ImapSimple | null = null;
  try {
    connection = await imaps.connect(getImapConfig(account));
    await connection.openBox(folder);

    const searchCriteria = [['UID', uid]];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    if (messages.length === 0) throw new Error(`Email with UID ${uid} not found.`);

    const m = messages[0];
    const headerPart = m.parts.find((p) => p.which === 'HEADER');
    const textPart = m.parts.find((p) => p.which === 'TEXT');
    
    return {
      uid: m.attributes.uid,
      headers: headerPart?.body,
      body: textPart?.body,
    };
  } finally {
    if (connection) connection.end();
  }
};

export const sendEmail = async (account: AccountConfig, to: string, subject: string, text: string) => {
  if (!account.allowMailWrite) throw new Error('Mail write permission denied.');

  const transporter = getSmtpTransporter(account);
  
  const info = await transporter.sendMail({
    from: account.sender,
    to,
    subject,
    text,
  });

  return info;
};

export const deleteEmail = async (account: AccountConfig, uid: number, folder: string = 'INBOX') => {
  if (!account.allowMailWrite) throw new Error('Mail write permission denied.');

  let connection: imaps.ImapSimple | null = null;
  try {
    connection = await imaps.connect(getImapConfig(account));
    await connection.openBox(folder);
    await connection.addFlags(uid, '\\Deleted');
    return { success: true, uid };
  } finally {
    if (connection) connection.end();
  }
};
