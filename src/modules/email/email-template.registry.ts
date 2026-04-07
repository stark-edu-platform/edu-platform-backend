import {
  setPasswordTemplate,
  type SetPasswordTemplateInput,
} from './templates/set-password.template.js';
import {
  schoolAdminInviteTemplate,
  type SchoolAdminInviteTemplateInput,
} from './templates/school-admin-invite.template.js';
import { EmailTemplateDefinition } from './email-template.types.js';

export type EmailTemplateMap = {
  setPassword: SetPasswordTemplateInput;
  schoolAdminInvite: SchoolAdminInviteTemplateInput;
};

export type EmailTemplateKey = keyof EmailTemplateMap;

type EmailTemplateRegistry = {
  [K in EmailTemplateKey]: EmailTemplateDefinition<EmailTemplateMap[K]>;
};

export const emailTemplateRegistry: EmailTemplateRegistry = {
  setPassword: setPasswordTemplate,
  schoolAdminInvite: schoolAdminInviteTemplate,
};
