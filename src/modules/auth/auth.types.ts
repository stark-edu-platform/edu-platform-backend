export type LoginBody = {
  loginId: string;
  password: string;
  deviceInfo?: string;
};

export type SetPasswordBody = {
  token: string;
  password: string;
};

export type ValidateSetupTokenBody = {
  token: string;
};

export type RefreshTokenBody = {
  refreshToken: string;
  deviceInfo?: string;
};

export type LogoutBody = {
  refreshToken: string;
};

export type AuthUserSchool = {
  schoolId: string;
  name: string;
  subdomain: string;
  status: string;
  primaryRole: string;
};

export type AuthUser = {
  userId: string;
  name: string | null;
  username: string;
  email: string | null;
  status: string;
  systemRole: string;
  schools?: AuthUserSchool[];
};

export type AuthResponse = {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
};
