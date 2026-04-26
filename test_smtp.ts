import nodemailer from 'nodemailer';

const user = 'zzqhmbb@icloud.com';
const pass = 'mwve-yzhe-sdol-hfta';

const transporter = nodemailer.createTransport({
  host: 'smtp.mail.me.com',
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: user,
    pass: pass,
  },
  debug: true,
  logger: true
});

transporter.sendMail({
  from: `"Test" <${user}>`,
  to: 'zzqhmbb@gmail.com',
  subject: 'Test SMTP',
  text: 'Hello from Node.js!'
}, (error, info) => {
  if (error) {
    console.error("SMTP Error:", error);
  } else {
    console.log('Message sent: %s', info.messageId);
  }
});
