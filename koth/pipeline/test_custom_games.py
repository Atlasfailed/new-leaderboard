import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from . import custom_games as model


def game(year, kings, peasants, won=True):
    return {
        "start_time": f"{year}-06-01T12:00:00Z",
        "map": "Test",
        "duration_ms": 600001,
        "kings_handicap": 50,
        "kings_won": won,
        "kings": [[user_id, f"Player {user_id}", "BE", 25] for user_id in kings],
        "peasants": [[user_id, f"Player {user_id}", "BE", 25] for user_id in peasants],
    }


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.games = [
            game(2024, [1, 2], [3, 4, 5, 6]),
            game(2025, [1, 3], [2, 4, 5, 6], False),
            game(2026, [1, 3], [2, 4, 5, 6]),
        ]
        self.details, _ = model.run_elo(self.games, [0, 0, 0])

    def test_api_duration_must_be_strictly_longer_than_ten_minutes(self):
        replay = {
            "startTime": "2026-06-01T12:00:00Z",
            "Map": {"scriptName": "Test"},
            "Spectators": [{"name": "Twig"}],
            "AllyTeams": [
                {"winningTeam": True, "Players": [
                    {"userId": 1, "name": "King", "handicap": 50},
                ]},
                {"winningTeam": False, "Players": [
                    {"userId": 2, "name": "Peasant", "handicap": 0},
                    {"userId": 3, "name": "Peasant 2", "handicap": 0},
                ]},
            ],
        }
        for duration in (0, 299999, 300000, 599999, 600000, 600001):
            with self.subTest(duration=duration):
                replay["durationMs"] = duration
                self.assertEqual(model.classify_replay(replay) is not None, duration > 600000)
        del replay["durationMs"]
        self.assertIsNone(model.classify_replay(replay))

    def test_rebuild_filters_cached_short_games_without_mutating_cache(self):
        from copy import deepcopy

        valid = game(2026, [1, 2], [3, 4, 5, 6])
        cache = {"games": {"valid": valid}}
        for duration in (300000, 599999, 600000):
            short = game(2025, [7, 8], [9, 10, 11, 12])
            short["duration_ms"] = duration
            cache["games"][str(duration)] = short
        before = deepcopy(cache)
        cutoff = datetime(2026, 7, 1, tzinfo=timezone.utc)
        actual = model.build_custom_rankings(cache, cutoff)
        expected = model.build_custom_rankings({"games": {"valid": valid}}, cutoff)
        self.assertEqual(actual, expected)
        self.assertEqual(cache, before)
        self.assertEqual([g["id"] for g in actual["games"]], ["valid"])

    def test_year_carries_experience_but_keeps_annual_stats(self):
        rows = model._build_role(self.games[1:2], self.details[1:2], "kings")
        player = next(p for p in rows if p["user_id"] == 1)
        self.assertEqual(player["games"], 1)
        self.assertEqual((player["wins"], player["losses"], player["streak"]), (0, 1, -1))
        rating = self.details[1]["deltas"]["kings"][1][1]
        expected = round(model._score(rating, 2, "kings"), 1)
        self.assertEqual(player["score"], expected)
        self.assertEqual(player["peak"], expected)
        self.assertNotEqual(player["score"], round(model._score(rating, 1, "kings"), 1))
        self.assertNotEqual(player["score"], round(model._score(rating, 3, "kings"), 1))

    def test_experience_is_separate_per_role(self):
        self.assertEqual(self.details[1]["role_games"]["kings"][3], 1)
        self.assertEqual(self.details[1]["role_games"]["peasants"][2], 1)
        self.assertEqual(self.details[1]["role_games"]["peasants"][4], 2)

    def test_starting_score_uses_january_experience_and_pre_match_rating(self):
        games = [game(2024, [1], [2, 3]), game(2026, [1, 4], [2, 3, 5])]
        details, _ = model.run_elo(games, [0, 0, 0])
        for role in model.ROLES:
            rows = model._build_role(games[1:], details[1:], role, datetime(2026, 11, 1, tzinfo=timezone.utc))
            for row in rows:
                user_id = row["user_id"]
                delta, rating = details[1]["deltas"][role][user_id]
                inherited = details[1]["year_experience"][role][user_id]["inherited"]
                self.assertEqual(row["starting_score"], round(model._score(rating - delta, inherited, role), 1))
                if user_id in (4, 5):
                    self.assertEqual(row["starting_score"], 800)
                else:
                    self.assertGreater(inherited, 0)
                    self.assertLess(inherited, 1)
                    self.assertNotEqual(row["starting_score"], round(model._score(
                        rating - delta, details[1]["effective_games_before"][role][user_id], role
                    ), 1))
            all_time = model._build_role(games, details, role)
            self.assertTrue(all("starting_score" not in row for row in all_time))

    def test_starting_score_is_fixed_as_current_score_decays(self):
        for role in model.ROLES:
            early = model._build_role(self.games[1:2], self.details[1:2], role, datetime(2025, 7, 1, tzinfo=timezone.utc))
            late = model._build_role(self.games[1:2], self.details[1:2], role, datetime(2025, 12, 1, tzinfo=timezone.utc))
            self.assertEqual([r["starting_score"] for r in early], [r["starting_score"] for r in late])

    def test_inactive_players_excluded_and_future_does_not_change_snapshot(self):
        rows = model._build_role(self.games[1:2], self.details[1:2], "kings")
        self.assertEqual({p["user_id"] for p in rows}, {1, 3})
        earlier, _ = model.run_elo(self.games[:2], [0, 0, 0])
        self.assertEqual(rows, model._build_role(self.games[1:2], earlier[1:2], "kings"))

    def test_annual_scores_include_idle_decay_and_all_time_scores_unchanged(self):
        cache = {"games": {str(i): g for i, g in enumerate(self.games)}}
        payload = model.build_custom_rankings(cache)
        _, final_ratings = model.run_elo(self.games, model.fit_baseline(self.games))
        for role in model.ROLES:
            for year in ("2024", "2025", "2026"):
                latest = {}
                for g in reversed(payload["games"]):
                    if g["start_time"].startswith(year):
                        latest.update({p[0]: p[4] for p in g[role]})
                for row in payload["rankings"][role][year]:
                    self.assertLessEqual(row["score"], latest[row["user_id"]])
            counts = {}
            for g in self.games:
                for user_id, *_ in g[role]:
                    counts[user_id] = counts.get(user_id, 0) + 1
            for row in payload["rankings"][role]["all"]:
                user_id = row["user_id"]
                self.assertEqual(row["score"], round(model._score(final_ratings[role][user_id], counts[user_id], role), 1))

    def test_cumulative_count_passes_thirty_game_cap(self):
        games = [game(2025, [1, 2], [3, 4, 5, 6]) for _ in range(35)]
        games.append(game(2026, [1, 2], [3, 4, 5, 6]))
        details, _ = model.run_elo(games, [0, 0, 0])
        row = model._build_role(games[-1:], details[-1:], "kings")[0]
        self.assertEqual(row["games"], 1)
        self.assertEqual(details[-1]["role_games"]["kings"][row["user_id"]], 36)
        self.assertEqual(row["score"], round(model._score(details[-1]["deltas"]["kings"][row["user_id"]][1], 30, "kings"), 1))

    def test_exact_half_life(self):
        start = datetime(2024, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(model._decay_games(50, start, start), 50)
        self.assertAlmostEqual(model._decay_games(50, start, start + timedelta(days=model.EXPERIENCE_HALF_LIFE_DAYS)), 25)
        self.assertAlmostEqual(model._decay_games(50, start, start + timedelta(days=4 * model.EXPERIENCE_HALF_LIFE_DAYS)), 3.125)
        self.assertEqual(model._year_games(30, 10, 2024, start + timedelta(days=90), "kings"), 25)
        self.assertEqual(model._year_games(30, 10, 2024, start + timedelta(days=180), "kings"), 17.5)
        self.assertEqual(model._year_games(50, 10, 2024, start + timedelta(days=90), "peasants"), 35)

    def test_experience_caps_before_decay_and_recovery(self):
        games = [game(2024, [1, 2], [3, 4, 5, 6]) for _ in range(100)]
        games.append(game(2026, [1, 2], [3, 4, 5, 6]))
        details, _ = model.run_elo(games, [0, 0, 0])
        self.assertEqual(details[-2]["effective_games"]["kings"][1], 30)
        gap = model._parse_time(games[-1]["start_time"]) - datetime(2025, 1, 1, tzinfo=timezone.utc)
        expected = 30 * 2 ** (-gap.total_seconds() / 86400 / model.EXPERIENCE_HALF_LIFE_DAYS) + 1
        self.assertAlmostEqual(details[-1]["effective_games"]["kings"][1], expected)
        self.assertLess(expected, 2.92)

    def test_effective_experience_is_role_specific(self):
        self.assertEqual(self.details[1]["effective_games"]["kings"][3], 1)
        self.assertEqual(self.details[1]["effective_games"]["peasants"][2], 1)
        self.assertGreater(self.details[1]["effective_games"]["kings"][1], 1)

    def test_finished_years_freeze_and_current_year_keeps_decaying(self):
        cache = {"games": {str(i): g for i, g in enumerate(self.games)}}
        first = model.build_custom_rankings(cache, datetime(2026, 7, 1, tzinfo=timezone.utc))
        later = model.build_custom_rankings(cache, datetime(2026, 12, 1, tzinfo=timezone.utc))
        future = model.build_custom_rankings(cache, datetime(2028, 1, 1, tzinfo=timezone.utc))
        next_year = model.build_custom_rankings(cache, datetime(2027, 1, 1, tzinfo=timezone.utc))
        for role in model.ROLES:
            self.assertEqual(first["rankings"][role]["all"], future["rankings"][role]["all"])
            for year in ("2024", "2025"):
                self.assertEqual(first["rankings"][role][year], later["rankings"][role][year])
            self.assertEqual(next_year["rankings"][role]["2026"], future["rankings"][role]["2026"])
            old = {row["user_id"]: row for row in first["rankings"][role]["2026"]}
            for row in later["rankings"][role]["2026"]:
                if old[row["user_id"]]["experience"]["inherited"] > 0:
                    self.assertLess(row["score"], old[row["user_id"]]["score"])
                else:
                    self.assertEqual(row["score"], old[row["user_id"]]["score"])
                self.assertEqual(row["rating"], old[row["user_id"]]["rating"])

    def test_year_end_score_uses_year_end_cutoff(self):
        cache = {"games": {str(i): g for i, g in enumerate(self.games)}}
        payload = model.build_custom_rankings(cache, datetime(2026, 7, 1, tzinfo=timezone.utc))
        row = payload["rankings"]["kings"]["2025"][0]
        experience = row["experience"]
        cutoff = datetime(2025, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        count = model._year_games(experience["inherited"], experience["games"], experience["year"], cutoff, "kings")
        self.assertEqual(row["score"], round(model._score(experience["rating"], count, "kings"), 1))

    def test_current_year_games_keep_full_weight(self):
        games = [game(2026, [1, 2], [3, 4, 5, 6]), game(2026, [1, 2], [3, 4, 5, 6])]
        games[0]["start_time"] = "2026-01-01T00:00:00Z"
        games[1]["start_time"] = "2026-12-01T00:00:00Z"
        details, _ = model.run_elo(games, [0, 0, 0])
        self.assertEqual(details[1]["effective_games"]["kings"][1], 2)
        row = model._build_role(games, details, "kings", datetime(2026, 12, 31, tzinfo=timezone.utc))[0]
        rating = details[-1]["deltas"]["kings"][row["user_id"]][1]
        self.assertEqual(row["score"], round(model._score(rating, 2, "kings"), 1))

    def test_decay_starts_only_at_year_boundary_and_has_no_reset(self):
        games = [game(2025, [1, 2], [3, 4, 5, 6])]
        games[0]["start_time"] = "2025-01-01T00:00:00Z"
        details, _ = model.run_elo(games, [0, 0, 0])
        state = details[0]["year_experience"]["kings"][1]
        self.assertEqual(state, {"inherited": 0, "games": 1, "year": 2025})
        boundary = datetime(2026, 1, 1, tzinfo=timezone.utc)
        inherited = model._year_games(**state, as_of=boundary, role="kings")
        self.assertEqual(inherited, 1)
        self.assertEqual(model._year_games(inherited, 0, 2026, boundary, "kings"), 1)
        self.assertEqual(model._year_games(inherited, 0, 2026, boundary + timedelta(days=90), "kings"), 0.5)

    def test_next_year_inherits_capped_prior_year_end_experience(self):
        games = [game(2024, [1, 2], [3, 4, 5, 6]), game(2025, [1, 2], [3, 4, 5, 6])]
        games[1]["start_time"] = "2025-04-01T00:00:00Z"
        details, _ = model.run_elo(games, [0, 0, 0])
        self.assertEqual(details[1]["year_experience"]["kings"][1]["inherited"], 1)
        self.assertAlmostEqual(details[1]["effective_games"]["kings"][1], 1.5)
        games.append(game(2026, [1, 2], [3, 4, 5, 6]))
        games[-1]["start_time"] = "2026-01-01T00:00:00Z"
        details, _ = model.run_elo(games, [0, 0, 0])
        inherited = 1 + 2 ** (-365 / 90)
        self.assertAlmostEqual(details[-1]["year_experience"]["kings"][1]["inherited"], inherited)
        self.assertAlmostEqual(details[-1]["effective_games"]["kings"][1], inherited + 1)

    def test_compressed_curve_preserves_endpoints_and_settles_at_thirty(self):
        self.assertEqual(model.SIGMA_FLOOR_GAMES, {"kings": 30, "peasants": 50})
        self.assertEqual(model.SIGMA_GAMES_SCALE, {"kings": 3, "peasants": 5})
        self.assertEqual(model._score(1500, 0, "kings"), 800)
        former_floor = 350 / (1 + 50 / 5) ** 0.5
        self.assertAlmostEqual(model._sigma(30, "kings"), former_floor)
        self.assertAlmostEqual(2 * model._sigma(30, "kings") / 42, 5.02518907629606)
        for n in range(30):
            self.assertGreater(model._sigma(n, "kings"), model._sigma(n + 1, "kings"))
            self.assertAlmostEqual(model._sigma(n, "kings"), 350 / (1 + (n * 50 / 30) / 5) ** 0.5)
        for n in (30, 31, 50, 1000):
            self.assertEqual(model._sigma(n, "kings"), model._sigma(30, "kings"))
        for n in range(60):
            self.assertAlmostEqual(model._sigma(n, "peasants"), 350 / (1 + min(n, 50) / 5) ** 0.5)
        self.assertEqual(model._year_games(30, 30, 2026, datetime(2026, 6, 1, tzinfo=timezone.utc), "kings"), 30)

    def test_compressing_experience_does_not_change_elo_or_match_deltas(self):
        baseline = model.fit_baseline(self.games)
        details, ratings = model.run_elo(self.games, baseline)
        with patch.multiple(model, SIGMA_FLOOR_GAMES={"kings": 50, "peasants": 50},
                            SIGMA_GAMES_SCALE={"kings": 5.0, "peasants": 5.0}):
            former_details, former_ratings = model.run_elo(self.games, baseline)
        self.assertEqual(ratings, former_ratings)
        self.assertEqual(
            [detail["deltas"] for detail in details],
            [detail["deltas"] for detail in former_details],
        )

    def test_history_uses_already_decayed_pre_game_score_after_a_long_break(self):
        games = [game(2025, [1, 2], [3, 4, 5, 6], i % 2 == 0) for i in range(30)]
        games.append(game(2026, [1, 2], [3, 4, 5, 6]))
        payload = model.build_custom_rankings(
            {"games": {str(i): g for i, g in enumerate(games)}},
            datetime(2026, 7, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(payload["scoreDecay"]["maxGames"], {"kings": 30, "peasants": 50})
        self.assertEqual(payload["scoreDecay"]["gamesScale"], {"kings": 3, "peasants": 5})
        details, _ = model.run_elo(games, model.fit_baseline(games))
        for output, detail in zip(reversed(payload["games"]), details):
            for role in model.ROLES:
                for entry in output[role]:
                    self.assertEqual(len(entry), 7)
                    self.assertEqual(entry[6], round(detail["deltas"][role][entry[0]][0], 1))
                    if output["winner"] == role:
                        self.assertGreater(entry[6], 0)
                    else:
                        self.assertLess(entry[6], 0)
        latest = payload["games"][0]["kings"][0]
        self.assertGreater(latest[6], 0)
        self.assertGreater(latest[5], latest[6])
        self.assertGreater(latest[3], 0)
        uid = latest[0]
        delta, rating = details[-1]["deltas"]["kings"][uid]
        before_games = details[-1]["effective_games_before"]["kings"][uid]
        expected_before_games = model._year_games(30, 0, 2026, model._parse_time(games[-1]["start_time"]), "kings")
        self.assertAlmostEqual(before_games, expected_before_games)
        expected_before_score = model._score(rating - delta, expected_before_games, "kings")
        expected_after_score = model._score(rating, expected_before_games + 1, "kings")
        self.assertEqual(latest[5], round(expected_after_score - expected_before_score, 1))
        previous_score = payload["games"][1]["kings"][0][4]
        self.assertLess(latest[4], previous_score)
        self.assertLess(expected_before_score, previous_score)

    def test_pre_game_experience_handles_first_games_same_day_and_saturation(self):
        games = [game(2025, [1, 2], [3, 4, 5, 6]) for _ in range(52)]
        games.append(game(2026, [1, 2], [3, 4, 5, 6]))
        games[-1]["start_time"] = "2026-01-01T00:00:00Z"
        details, _ = model.run_elo(games, [0, 0, 0])
        for role, uid in (("kings", 1), ("peasants", 3)):
            cap = 30 if role == "kings" else 50
            self.assertEqual(details[0]["effective_games_before"][role][uid], 0)
            self.assertEqual(details[1]["effective_games_before"][role][uid], 1)
            for index in (cap, 51, 52):
                self.assertEqual(details[index]["effective_games_before"][role][uid], cap)
                self.assertEqual(details[index]["effective_games"][role][uid], cap)
            self.assertEqual(details[-1]["year_experience"][role][uid]["inherited"], cap)
        payload = model.build_custom_rankings({"games": {str(i): g for i, g in enumerate(games)}})
        for output in payload["games"][:3]:
            for role in model.ROLES:
                for entry in output[role]:
                    self.assertEqual(entry[5], entry[6])

    def test_role_specific_caps_apply_to_tables_peaks_and_history(self):
        games = [game(2026, [1, 2], [3, 4, 5, 6], i % 2 == 0) for i in range(35)]
        payload = model.build_custom_rankings(
            {"games": {str(i): g for i, g in enumerate(games)}},
            datetime(2026, 7, 1, tzinfo=timezone.utc),
        )
        details, ratings = model.run_elo(games, model.fit_baseline(games))
        for role, uid, cap, scale in (("kings", 1, 30, 3), ("peasants", 3, 50, 5)):
            scores = [
                detail["deltas"][role][uid][1] - 700 / (1 + min(i + 1, cap) / scale) ** 0.5
                for i, detail in enumerate(details)
            ]
            for period in ("all", "2026"):
                row = next(r for r in payload["rankings"][role][period] if r["user_id"] == uid)
                self.assertEqual(row["score"], round(scores[-1], 1))
                self.assertEqual(row["peak"], round(max(scores), 1))
                if period != "all":
                    self.assertEqual(row["experience"]["games"], min(35, cap))
            for i, output in enumerate(reversed(payload["games"])):
                entry = next(e for e in output[role] if e[0] == uid)
                delta, rating = details[i]["deltas"][role][uid]
                before = rating - delta - 700 / (1 + min(i, cap) / scale) ** 0.5
                self.assertEqual(entry[2], round(scores[i], 1))
                self.assertEqual(entry[4], entry[2])
                self.assertEqual(entry[5], round(scores[i] - before, 1))
            self.assertEqual(ratings[role][uid], details[-1]["deltas"][role][uid][1])


if __name__ == "__main__":
    unittest.main()
