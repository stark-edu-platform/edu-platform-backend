import { Brevo, BrevoClient } from '@getbrevo/brevo';
import { readSharedEnv } from '../../config/shared-env.js';
import { createLogger } from '../../utils/logger.js';

export interface EmailPayload {
  to: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
  senderName?: string;
  senderEmail?: string;
}

type EmailSuccessResult = {
  success: true;
  messageId: string | undefined;
};

class EmailService {
  private readonly brevo: BrevoClient;
  private readonly env: ReturnType<typeof readSharedEnv>;
  private readonly logger = createLogger('email-service');

  constructor() {
    this.env = readSharedEnv();
    this.brevo = new BrevoClient({
      apiKey: this.env.BREVO_API_KEY || '',
      timeoutInSeconds: 30,
      maxRetries: 3,
    });
  }

  async send({
    to,
    subject,
    htmlContent,
    textContent,
    senderName,
    senderEmail,
  }: EmailPayload): Promise<EmailSuccessResult> {
    this.assertConfigured();

    const recipientEmail = to.trim().toLowerCase();

    const request: Brevo.SendTransacEmailRequest = {
      subject,
      htmlContent,
      textContent,
      sender: {
        name: senderName || this.env.SENDER_NAME || 'My Application',
        email: senderEmail || this.env.SENDER_EMAIL || '',
      },
      to: [{ email: recipientEmail }],
    };

    try {
      const result =
        await this.brevo.transactionalEmails.sendTransacEmail(request);

      this.logger.success('Email sent successfully.', {
        provider: 'brevo',
        recipientEmail,
        messageId: result.messageId,
      });

      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (err: unknown) {
      this.handleError(err);
      throw err;
    }
  }

  private assertConfigured() {
    if (!this.env.BREVO_API_KEY) {
      throw new Error(
        'BREVO_API_KEY is not configured. Set it before sending emails.',
      );
    }

    if (!this.env.SENDER_EMAIL) {
      throw new Error(
        'SENDER_EMAIL is not configured. Set a verified Brevo sender email before sending emails.',
      );
    }
  }

  private handleError(err: unknown) {
    const error = err as {
      statusCode?: number;
      message?: string;
      response?: {
        status?: number;
      };
    };

    const status = error.statusCode || error.response?.status;
    const message = error.message || 'Unknown Brevo Error';

    if (status === 401) {
      this.logger.error('Invalid Brevo API key.', {
        statusCode: status,
        provider: 'brevo',
      });
      return;
    }

    if (status === 429) {
      this.logger.warn('Brevo rate limit reached.', {
        statusCode: status,
        provider: 'brevo',
      });
      return;
    }

    if (status === 400) {
      this.logger.error(
        'Brevo rejected the email request. Check whether the sender email is verified.',
        { statusCode: status, provider: 'brevo', errorMessage: message },
      );
      return;
    }

    this.logger.error('Email delivery failed.', {
      statusCode: status,
      provider: 'brevo',
      errorMessage: message,
    });
  }
}

export const emailService = new EmailService();
