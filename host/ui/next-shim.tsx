// Framework boundary only. The proof imports the actual Cavioo UI components.
import React from "react";
export const useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} });
export const useSearchParams = () => new URLSearchParams();
export const usePathname = () => "/offline-proof";
export const useParams = () => ({});
export const useClerk = () => ({ signOut: () => {} });
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useUser = () => ({ isLoaded: true, isSignedIn: false, user: null });
export const useSession = () => ({ session: null });
export const useSessionList = () => ({ sessions: [] });
export const SignInButton = ({ children }: {children: React.ReactNode}) => <>{children}</>;
export default React.forwardRef<HTMLImageElement, React.ImgHTMLAttributes<HTMLImageElement> & {
  unoptimized?: boolean; fill?: boolean; priority?: boolean; quality?: number;
}>(function ProofImage({ unoptimized: _u, fill: _f, priority: _p, quality: _q, ...props }, ref) {
  // No image conversion: the exact hash-checked original is displayed.
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} ref={ref} />;
});
