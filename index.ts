import { S3Client } from '@capgo/s3-lite-client';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { stripHtml } from 'string-strip-html';

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const s3Endpoint = process.env.S3_ENDPOINT
const s3AccessKey = process.env.S3_ACCESS_KEY
const s3AccessSecret = process.env.S3_ACCESS_SECRET

if (!supabaseUrl || !supabaseKey || !s3AccessKey || !s3Endpoint || !s3AccessSecret) throw new Error('missing env vars')

const supabase = createClient(supabaseUrl, supabaseKey);
const s3 = new S3Client({
  endPoint: s3Endpoint,
  port: 443,
  useSSL: true,
  region: "apac",
  bucket: "ayobaca",
  accessKey: s3AccessKey,
  secretKey: s3AccessSecret,
  pathStyle: true,
});

const storeImagesToS3 = async (bookId: string, images: { page: number, imageUrl: string }[]) => {
  for (const image of images) {
    try {
      console.log(`Storing ${bookId}: page ${image.page}`)
      const imageRaw = await fetch(image.imageUrl)
      const imageBuffer = Buffer.from(await imageRaw.arrayBuffer())
      const webpBuffer = await sharp(imageBuffer).webp().toBuffer();

      await s3.putObject(`${bookId}/${image.page}.webp`, webpBuffer);
    } catch (e) {
      console.log('Skipping due to blank image...')
    }
  }
  console.log('----DONE STORING IMAGES----')
}

/**
 * A function to fetch all books from https://letsreadasia.org
 * and insert them into supabase. It will be served as cached version official API.
 */
(async () => {
  let cursor: string | null = '4';

  const { data: existingBooks, error } = await supabase.from('books').select('masterBookId')
  if (error) throw error;

  while (cursor !== null) {
    const requests = await fetch(`https://letsreadasia.org/api/book/elastic/search/?searchText=&lId=6260074016145408&limit=100&cursor=${cursor}`)
    const data = await requests.json() as any;
    cursor = data.cursorWebSafeString;

    // check if the book is unsynced
    const unsyncedBooks = data.other.filter((book: any) => !existingBooks.find((b: any) => b.masterBookId === book.masterBookId))

    // if (unsyncedBooks.length === 0) {
    //   console.log(`All books synced in page ${cursor}. Continue...`)
    //   continue;
    // }

    for (const book of data.other) {
      // fetch details
      console.log(`fetching "${book.name}" / ${book.masterBookId}...`)
      const content = await (
        await fetch(`https://letsreadasia.org/api/v5/book/preview/language/6260074016145408/book/${book.masterBookId}`)
      ).json() as any;

      let pageNum = 1;
      const details: any = []
      const images = [{ page: 0, imageUrl: content.thumborCoverImageUrl }]
      for (const page of content.pages) {
        if (page.imageUrl === "") {
          continue;
        }

        // find duplicates
        if (details.find((d: any) => d.bookDetailId === page.id.toString())) {
          continue;
        }

        details.push({
          bookDetailId: `${page.id}`,
          bookId: book.masterBookId,
          content: stripHtml(page.extractedLongContentValue.toLowerCase())
            .result
            .replace(/[^a-zA-Z0-9]/g, ' ')
            .trim(),
          contentRaw: page.extractedLongContentValue,
          imageUrl: page.imageUrl,
          pageNum: pageNum
        })

        images.push({ page: pageNum, imageUrl: page.imageUrl })
        pageNum += 1;
      }

      // save book
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
        totalPages: pageNum - 1,
        tags: book.tags
          .map((tag: any) => ({ id: tag.id, name: tag.name })),
        availableLanguages: book.availableLanguages
          .map((lang: any) => ({ id: lang.id, name: lang.name }))
      }, {
        onConflict: 'masterBookId'
      })
      if (error) throw error;

      // fetch images
      await storeImagesToS3(
        book.masterBookId,
        images
      )

      // save book details
      const { error: insertDetailError } = await supabase.from('book_details').upsert(details, {
        onConflict: 'bookDetailId'
      })

      if (insertDetailError) throw insertDetailError;
    }

    console.log(`---------DONE PAGE ${cursor}---------`);
  }
  console.log("---------DONE ALL---------");
})()
