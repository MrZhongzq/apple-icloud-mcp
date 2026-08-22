import nodemailer, { type Transporter } from 'nodemailer';
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';

const HOST = 'smtp.mail.me.com';
const PORT = 587;

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface SmtpProvider {
  send(message: OutgoingMessage): Promise<SendResult>;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpProviderDeps {
  /** 测试注入点：默认构造真实 nodemailer transporter。 */
  createTransport?: () => Transporter;
}

export function mapSmtpError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const error = err as { responseCode?: number; code?: string };
  const code = error.responseCode;

  if (code === 535 || code === 534 || error.code === 'EAUTH') {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了发信认证', {
      hint: '确认 App 专用密码有效，且 ICLOUD_SENDER 与该密码属于同一账号',
      cause: err,
    });
  }
  if (code === 421 || code === 450 || code === 451 || code === 452) {
    return new AppError('RATE_LIMITED', 'iCloud 暂时限制了发信', { retryable: true, cause: err });
  }
  if (code !== undefined && code >= 500 && code < 600) {
    return new AppError('INVALID_INPUT', '收件人或邮件内容被服务器拒绝', {
      hint: '检查收件人地址是否正确',
      cause: err,
    });
  }
  return new AppError('UPSTREAM_ERROR', '发信失败', { retryable: true, cause: err });
}

/** SMTP 与 IMAP 一样使用 account.sender 认证，且发件人必须是该地址。 */
export function createSmtpProvider(account: AccountConfig, deps: SmtpProviderDeps = {}): SmtpProvider {
  const buildTransport =
    deps.createTransport ??
    (() =>
      nodemailer.createTransport({
        host: HOST,
        port: PORT,
        secure: false,
        requireTLS: true,
        auth: { user: account.sender, pass: account.appPassword },
      }));
  let transporter: Transporter | undefined;

  const get = (): Transporter => {
    transporter ??= buildTransport();
    return transporter;
  };

  return {
    async verify() {
      try {
        await get().verify();
      } catch (err) {
        throw mapSmtpError(err);
      }
    },

    async send(message) {
      try {
        const info = await get().sendMail({
          from: account.sender,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          text: message.text,
          html: message.html,
          inReplyTo: message.inReplyTo,
          references: message.inReplyTo ? [message.inReplyTo] : undefined,
        });
        return {
          messageId: info.messageId,
          accepted: info.accepted.map(String),
          rejected: info.rejected.map(String),
        };
      } catch (err) {
        throw mapSmtpError(err);
      }
    },

    async close() {
      // 惰性构造：verify()/send() 从未调用过时 transporter 还不存在，无需关闭。
      if (!transporter) return;
      transporter.close();
      transporter = undefined;
    },
  };
}
