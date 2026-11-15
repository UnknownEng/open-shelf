'use strict';
const { one, run, tx, now } = require('./db');

// [id, title, author, category, condition, isbn, copies, description]
const CATALOGUE = [
  ['b1', 'The Forty Rules of Love', 'Elif Shafak', 'Fiction', 'Good', '9780143426176', 2, 'A much-loved story about Rumi and Shams, told across two centuries.'],
  ['b2', 'Atomic Habits', 'James Clear', 'Personal growth', 'Like new', '9780735211292', 3, 'A clear, practical guide to building small habits that compound.'],
  ['b3', 'A Case of Exploding Mangoes', 'Mohammed Hanif', 'Fiction', 'Good', '9788184001754', 1, 'Funny, sharp and very readable political satire.'],
  ['b4', 'The Alchemist', 'Paulo Coelho', 'Fiction', 'Like new', '9780062315007', 2, 'A classic fable about listening to your heart and following a dream.'],
  ['b5', 'Sapiens', 'Yuval Noah Harari', 'Non-fiction', 'Good', '9780099590088', 2, 'A sweeping history of humankind, from foragers to the future.'],
  ['b6', 'The Little Prince', 'Antoine de Saint-Exupéry', 'Children', 'Good', '9780156012195', 1, 'A lovely illustrated edition of the timeless tale.'],
  ['b7', 'The Kite Runner', 'Khaled Hosseini', 'Fiction', 'Good', '9781594631931', 2, 'A moving story of friendship, betrayal and redemption.'],
  ['b8', 'Educated', 'Tara Westover', 'Memoir', 'Like new', '9780399590504', 1, 'A memoir about family, learning and self-invention.'],
  ['b9', 'The Psychology of Money', 'Morgan Housel', 'Personal growth', 'Good', '9780857197689', 2, 'Short stories about how people really think about money.'],
  ['b10', 'Nineteen Eighty-Four', 'George Orwell', 'Classics', 'Good', '9780451524935', 2, 'The defining novel of surveillance, truth and power.'],
  ['b11', 'To Kill a Mockingbird', 'Harper Lee', 'Classics', 'Well-loved', '9780061120084', 1, 'Justice and childhood in the American South.'],
  ['b12', 'The Great Gatsby', 'F. Scott Fitzgerald', 'Classics', 'Good', '9780743273565', 1, 'Glamour, longing and the green light across the bay.'],
  ['b13', 'Dune', 'Frank Herbert', 'Sci-fi & fantasy', 'Good', '9780441172719', 2, 'Desert planets, prophecy and the spice that controls the universe.'],
  ['b14', 'The Midnight Library', 'Matt Haig', 'Fiction', 'Like new', '9780525559474', 2, 'Between life and death is a library of every life you could have lived.'],
  ['b15', 'Thinking, Fast and Slow', 'Daniel Kahneman', 'Non-fiction', 'Good', '9780374533557', 1, 'The two systems that drive the way we think and decide.'],
  ['b16', 'Pride and Prejudice', 'Jane Austen', 'Classics', 'Good', '9780141439518', 1, 'Wit, romance and first impressions.'],
  ['b17', 'The Hobbit', 'J.R.R. Tolkien', 'Sci-fi & fantasy', 'Good', '9780547928227', 2, 'There and back again — the adventure that started it all.'],
  ['b18', 'Deep Work', 'Cal Newport', 'Personal growth', 'Like new', '9781455586691', 1, 'Rules for focused success in a distracted world.'],
  ['b19', "Man's Search for Meaning", 'Viktor E. Frankl', 'Memoir', 'Good', '9780807014271', 1, 'A psychiatrist on finding purpose in the darkest places.'],
  ['b20', 'Where the Crawdads Sing', 'Delia Owens', 'Fiction', 'Good', '9780735219090', 1, 'A coming-of-age mystery set in the marshes of North Carolina.'],
];

function seedCatalogue() {
  tx(() => {
    for (const [bookId, title, author, category, condition, isbn, copies, description] of CATALOGUE) {
      if (one('SELECT id FROM books WHERE id=?', bookId)) {
        run("UPDATE books SET isbn=?, total_copies=?, cover='', category=? WHERE id=? AND isbn IS NULL", isbn, copies, category, bookId);
      } else {
        run("INSERT INTO books(id,tenant_id,title,author,category,condition,description,cover,isbn,total_copies,created_at) VALUES(?,'default',?,?,?,?,?,'',?,?,?)",
          bookId, title, author, category, condition, description, isbn, copies, now());
      }
    }
  });
}

module.exports = { seedCatalogue, CATALOGUE };
