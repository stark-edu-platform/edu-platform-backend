export type CreateSchoolWithAdminBody = {
  schoolName: string;
  subdomain: string;
  board?: string;
  address?: string;
  schoolPhone?: string;
  schoolEmail?: string;
  adminName: string;
  adminEmail: string;
  adminPhone?: string;
  adminDesignation?: string;
};

export type DeveloperSchoolListItem = {
  schoolId: string;
  name: string;
  subdomain: string;
  board: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
  admin: {
    userId: string;
    name: string | null;
    email: string | null;
    status: string;
  } | null;
};
