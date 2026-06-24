-- Seed: admin-account
-- Gebruikersnaam: admin
-- Wachtwoord:     Bevdploeg
-- (de hash hieronder is SHA-256 van "Bevdploeg" — het wachtwoord zelf staat nergens opgeslagen)

INSERT INTO admins (gebruikersnaam, wachtwoord_hash)
VALUES ('admin', '6a6648e0991cb79e755f975f4960152e87a65b61e03f4fc6bded13297fad164e');
