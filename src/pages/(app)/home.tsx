import { Navigate } from 'react-router-dom'

/** The app's home is the team list. */
export default function HomePage() {
  return <Navigate to="/teams" replace />
}
