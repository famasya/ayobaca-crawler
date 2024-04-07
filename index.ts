import { createClient } from '@supabase/supabase-js';
import { stripHtml } from "string-strip-html";

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) throw new Error('missing env vars SUPABASE_URL or SUPABASE_KEY')

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * A function to fetch all books from https://letsreadasia.org
 * and insert them into supabase. It will be served as cached version official API.
 */
(async () => {
  let cursor = '0';

  while (cursor !== null) {
    const requests = await fetch(`https://letsreadasia.org/api/book/elastic/search/?searchText=&lId=6260074016145408&limit=100&cursor=${cursor}`)
    const data = await requests.json() as any;

    for (const book of data.other) {
      // fetch details
      console.log(`fetching "${book.name}" / ${book.masterBookId}...`)
      const content = await (
        await fetch(`https://letsreadasia.org/api/v5/book/preview/language/6260074016145408/book/${book.masterBookId}`)
      ).json() as any;

      const { error } = await supabase.from('books').upsert({
        name: book.name,
        authors: content
          .collaboratorsByRole['AUTHOR']
          .map((author: any) => author.name)
          .join(", ")
          .trim(),
        description: book.description,
        coverImage: book.thumborCoverImageUrl,
        language: book.language.name,
        readingLevel: Number.parseInt(book.readingLevel),
        languageId: book.languageId,
        masterBookId: book.masterBookId,
        totalPages: book.totalPages,
        tags: book.tags
          .map((tag: any) => ({ id: tag.id, name: tag.name })),
        availableLanguages: book.availableLanguages
          .map((lang: any) => ({ id: lang.id, name: lang.name }))
      }, {
        onConflict: 'masterBookId'
      })

      if (error) throw new Error(error.message)

      const bookDetail = content.pages.map((page: any) => ({
        bookDetailId: `${page.id}`,
        bookId: book.masterBookId,
        content: stripHtml(page.extractedLongContentValue.toLowerCase())
          .result
          .replace(/[^a-zA-Z0-9]/g, ' ')
          .trim(),
        imageUrl: page.imageUrl,
        pageNum: page.pageNum
      })).reduce((acc: any, current: any) => {
        // remove duplicates
        const filtered = acc.find((item: any) => item.bookDetailId === current.bookDetailId)
        if (filtered === undefined) {
          return [...acc, current]
        }
        return acc;
      }, [])

      const { error: insertDetailError } = await supabase.from('book_details').upsert(bookDetail, {
        onConflict: 'bookDetailId'
      })

      if (insertDetailError) throw new Error(insertDetailError.message)
    }

    console.log(`---------DONE PAGE ${cursor}---------`)

    cursor = data.cursorWebSafeString
  }
  console.log("---------DONE ALL---------")
})()
