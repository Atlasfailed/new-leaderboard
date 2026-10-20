import unittest

from . import custom_games as model


def game(year, kings, peasants, won=True):
    return {
        "start_time": f"{year}-06-01T12:00:00Z",
        "map": "Test",
        "duration_ms": 600000,
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

    def test_year_carries_experience_but_keeps_annual_stats(self):
        rows = model._build_role(self.games[1:2], self.details[1:2], "kings")
        player = next(p for p in rows if p["user_id"] == 1)
        self.assertEqual(player["games"], 1)
        self.assertEqual((player["wins"], player["losses"], player["streak"]), (0, 1, -1))
        rating = self.details[1]["deltas"]["kings"][1][1]
        expected = round(model._score(rating, 2), 1)
        self.assertEqual(player["score"], expected)
        self.assertEqual(player["peak"], expected)
        self.assertNotEqual(player["score"], round(model._score(rating, 1), 1))
        self.assertNotEqual(player["score"], round(model._score(rating, 3), 1))

    def test_experience_is_separate_per_role(self):
        self.assertEqual(self.details[1]["role_games"]["kings"][3], 1)
        self.assertEqual(self.details[1]["role_games"]["peasants"][2], 1)
        self.assertEqual(self.details[1]["role_games"]["peasants"][4], 2)

    def test_inactive_players_excluded_and_future_does_not_change_snapshot(self):
        rows = model._build_role(self.games[1:2], self.details[1:2], "kings")
        self.assertEqual({p["user_id"] for p in rows}, {1, 3})
        earlier, _ = model.run_elo(self.games[:2], [0, 0, 0])
        self.assertEqual(rows, model._build_role(self.games[1:2], earlier[1:2], "kings"))

    def test_annual_scores_match_popup_and_all_time_scores_unchanged(self):
        cache = {"games": {str(i): g for i, g in enumerate(self.games)}}
        payload = model.build_custom_rankings(cache)
        _, final_ratings = model.run_elo(self.games, model.fit_baseline(self.games))
        for role in model.ROLES:
            for year in ("2024", "2025", "2026"):
                latest = {}
                for g in reversed(payload["games"]):
                    if g["start_time"].startswith(year):
                        latest.update({p[0]: p[2] for p in g[role]})
                for row in payload["rankings"][role][year]:
                    self.assertEqual(row["score"], latest[row["user_id"]])
            counts = {}
            for g in self.games:
                for user_id, *_ in g[role]:
                    counts[user_id] = counts.get(user_id, 0) + 1
            for row in payload["rankings"][role]["all"]:
                user_id = row["user_id"]
                self.assertEqual(row["score"], round(model._score(final_ratings[role][user_id], counts[user_id]), 1))

    def test_cumulative_count_passes_fifty_game_cap(self):
        games = [game(2025, [1, 2], [3, 4, 5, 6]) for _ in range(55)]
        games.append(game(2026, [1, 2], [3, 4, 5, 6]))
        details, _ = model.run_elo(games, [0, 0, 0])
        row = model._build_role(games[-1:], details[-1:], "kings")[0]
        self.assertEqual(row["games"], 1)
        self.assertEqual(row["score"], round(model._score(details[-1]["deltas"]["kings"][row["user_id"]][1], 50), 1))


if __name__ == "__main__":
    unittest.main()
