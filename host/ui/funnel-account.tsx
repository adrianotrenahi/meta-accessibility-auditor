// Synthetic local account for this isolated tool; never imports Clerk services.
const user = {
  id: "testing-account",
  firstName: "Testing",
  lastName: "Account",
  fullName: "Testing Account",
  username: "testing-account",
  imageUrl: null,
  primaryEmailAddress: { emailAddress: "testing-account@access-walk.test" },
};
export const useUser = () => ({ isLoaded: true, isSignedIn: true, user });
export const useAuth = () => ({
  isLoaded: true,
  isSignedIn: true,
  userId: user.id,
});
export const useClerk = () => ({
  signOut: async () => {},
  openSignIn: () => {},
  setActive: async () => {},
});
export const useSession = () => ({ session: { id: "offline-session" } });
export const useSessionList = () => ({ isLoaded: true, sessions: [] });
export const SignInButton = () => null;
